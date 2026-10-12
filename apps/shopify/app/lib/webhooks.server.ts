// UC-12 guard, UC-16 uninstall/redact, idempotency (FR-12, NFR Reliability).
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { productVariantsQuery } from "./queries";
import { legacyId, nodeToSnapshot, type VariantNode } from "./snapshot";
import { reevaluateShop } from "./evaluate.server";
import { upsertSnapshots } from "./snapshot-store.server";
import { cancelScans } from "./scan.server";
import { nspidKey } from "./writes.server";

/** Returns false if this webhook id was already processed. */
export async function firstDelivery(db: PrismaClient, webhookId: string | null | undefined, shopDomain: string, topic: string) {
  if (!webhookId) return true;
  try {
    await db.webhookEvent.create({ data: { webhookId, shopDomain, topic } });
    return true;
  } catch (e: any) {
    if (e?.code === "P2002") return false; // unique violation → duplicate delivery
    throw e;
  }
}

/** UC-12: fetch the product's variants (paginated, E-05), upsert snapshots, re-run rules. */
export async function guardProduct(db: PrismaClient, gql: Gql, shopId: string, productGid: string) {
  const k = await nspidKey(db, shopId);
  const nodes: VariantNode[] = [];
  let after: string | null = null;
  do {
    const data: any = await gql(productVariantsQuery(k), { q: `product_id:${legacyId(productGid)}`, after });
    nodes.push(...data.productVariants.nodes);
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);

  const prev = await db.variantSnapshot.findMany({ where: { shopId, productId: productGid }, select: { variantId: true } });
  const liveIds = new Set(nodes.map((n) => n.id));
  const removed = prev.filter((p) => !liveIds.has(p.variantId)).map((p) => p.variantId);
  await upsertSnapshots(db, nodes.map((n) => nodeToSnapshot(shopId, n, null)), { keepScanId: true });
  if (removed.length) {
    await db.$transaction([
      db.variantSnapshot.deleteMany({ where: { shopId, variantId: { in: removed } } }),
      db.issue.updateMany({ where: { shopId, variantId: { in: removed }, status: "open" }, data: { status: "resolved", resolvedAt: new Date() } }),
    ]);
  }
  return reevaluateShop(db, shopId, { source: "guard" });
}

/** products/delete is not subscribed; a product deleted in Shopify drops out on the next guard or scan. */

export async function onUninstalled(db: PrismaClient, gql: Gql | null, shopDomain: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;
  await db.$transaction([
    db.shop.update({ where: { id: shop.id }, data: { active: false, uninstalledAt: new Date(), plan: "free" } }),
    // UC-16: revoke supplier links.
    db.supplierRequest.updateMany({ where: { shopId: shop.id }, data: { revoked: true } }),
    // E-12: stop jobs.
    db.job.updateMany({ where: { shopId: shop.id, status: { in: ["queued", "running"] } }, data: { status: "failed" } }),
    db.session.deleteMany({ where: { shop: shopDomain } }),
  ]);
  await cancelScans(db, gql, shop.id);
}

/** UC-16 / AT-17: delete every row for the shop. Metafields in Shopify stay; they belong to the merchant. */
export async function redactShop(db: PrismaClient, shopDomain: string) {
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  await db.$transaction([
    ...(shop
      ? [
          db.auditLog.deleteMany({ where: { shopId: shop.id } }),
          db.job.deleteMany({ where: { shopId: shop.id } }),
          db.issue.deleteMany({ where: { shopId: shop.id } }),
          db.variantSnapshot.deleteMany({ where: { shopId: shop.id } }),
          db.supplierRequest.deleteMany({ where: { shopId: shop.id } }), // cascades items + submissions
          db.scan.deleteMany({ where: { shopId: shop.id } }),
          db.settings.deleteMany({ where: { shopId: shop.id } }),
          db.shop.delete({ where: { id: shop.id } }),
        ]
      : []),
    db.session.deleteMany({ where: { shop: shopDomain } }),
    db.webhookEvent.deleteMany({ where: { shopDomain } }),
  ]);
}
