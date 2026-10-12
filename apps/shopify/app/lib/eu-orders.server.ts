// EU focus: which variants actually ship to EU shoppers.
// Reads orders from the last 60 days (the read_orders window), keeps only parcels shipped to
// one of the 27 EU countries, and stores per-variant counts plus a short order list for the
// printable customs-codes sheet. B2B orders (company buyers) are skipped: the EU product-ID
// rule covers B2C distance sales. Cancelled and test orders are skipped.
// Data kept: order number, date, country, line items. No names, emails, phones or addresses.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { EU_ORDERS } from "./queries";
import { EU_COUNTRIES } from "./shop.server";
import { log } from "./log.server";

import { EU_WINDOW_DAYS } from "./constants";
export { EU_WINDOW_DAYS };
const MAX_ORDERS = 20_000; // safety cap; 800 pages of 25
const KEEP_ORDERS = 500; // orders kept for the print sheet

export type EuLine = {
  variantId: string | null;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  unitPrice: string | null;
  currency: string | null;
};

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  test: boolean;
  shippingAddress: { countryCodeV2: string | null } | null;
  purchasingEntity: { __typename: string } | null;
  lineItems: {
    nodes: {
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      variant: { id: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
    }[];
  };
};

/** Message for errors that mean "the app may not read orders yet". */
export function isAccessError(msg: string) {
  return /access denied|not approved|protected customer data|read_orders|scope|ACCESS_DENIED|permission/i.test(msg);
}

export async function syncEuOrders(db: PrismaClient, gql: Gql, shopId: string, now = new Date()) {
  await db.shop.update({ where: { id: shopId }, data: { euSyncStatus: "running", euSyncError: null } });
  const since = new Date(now.getTime() - EU_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const demand = new Map<string, { orders: number; units: number; lastOrderAt: Date }>();
  const kept: { orderId: string; name: string; createdAt: Date; country: string; lines: EuLine[] }[] = [];
  let euOrders = 0;
  let seen = 0;
  let after: string | null = null;
  try {
    do {
      const data: { orders: { nodes: OrderNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(EU_ORDERS, {
        q: `created_at:>=${since}`,
        after,
      });
      for (const o of data.orders.nodes) {
        seen++;
        if (o.cancelledAt || o.test) continue;
        const country = o.shippingAddress?.countryCodeV2 ?? "";
        if (!EU_COUNTRIES.includes(country)) continue;
        if (o.purchasingEntity?.__typename === "PurchasingCompany") continue;
        euOrders++;
        const at = new Date(o.createdAt);
        const lines: EuLine[] = o.lineItems.nodes.map((l) => ({
          variantId: l.variant?.id ?? null,
          title: l.title,
          variantTitle: l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : "",
          sku: l.sku ?? "",
          quantity: l.quantity,
          unitPrice: l.originalUnitPriceSet?.shopMoney.amount ?? null,
          currency: l.originalUnitPriceSet?.shopMoney.currencyCode ?? null,
        }));
        const counted = new Set<string>();
        for (const l of lines) {
          if (!l.variantId) continue;
          const d = demand.get(l.variantId) ?? { orders: 0, units: 0, lastOrderAt: at };
          d.units += l.quantity;
          if (!counted.has(l.variantId)) d.orders++;
          counted.add(l.variantId);
          if (at > d.lastOrderAt) d.lastOrderAt = at;
          demand.set(l.variantId, d);
        }
        if (kept.length < KEEP_ORDERS) kept.push({ orderId: o.id, name: o.name, createdAt: at, country, lines });
      }
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (after && seen < MAX_ORDERS);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = isAccessError(msg) ? "no_access" : "failed";
    await db.shop.update({ where: { id: shopId }, data: { euSyncStatus: status, euSyncError: msg.slice(0, 500) } });
    log.warn("eu_sync_failed", { shopId, status, err: msg });
    return { ok: false as const, status, error: msg };
  }

  await db.$transaction([
    db.euDemand.deleteMany({ where: { shopId } }),
    db.euOrder.deleteMany({ where: { shopId } }),
    db.euDemand.createMany({
      data: [...demand.entries()].map(([variantId, d]) => ({ shopId, variantId, ...d })),
    }),
    db.euOrder.createMany({
      data: kept.map((k) => ({ shopId, ...k, lines: k.lines as any })),
    }),
    db.shop.update({
      where: { id: shopId },
      data: { euSyncStatus: "ok", euSyncError: null, euSyncedAt: new Date(), euOrderCount: euOrders },
    }),
  ]);
  log.info("eu_sync_complete", { shopId, ordersSeen: seen, euOrders, variants: demand.size });
  return { ok: true as const, euOrders, variants: demand.size, ordersSeen: seen };
}

/** Is the EU filter in effect for this shop? Only when the merchant wants it and we have data. */
export function euFilterOn(shop: { euSyncStatus: string | null; euOrderCount: number; settings: { euOnly: boolean } | null }) {
  return !!shop.settings?.euOnly && shop.euSyncStatus === "ok" && shop.euOrderCount > 0;
}

export async function euVariantIds(db: PrismaClient, shopId: string): Promise<Set<string>> {
  const rows = await db.euDemand.findMany({ where: { shopId }, select: { variantId: true } });
  return new Set(rows.map((r) => r.variantId));
}

/** customers/redact: drop the listed orders from the print list. Counts stay (no customer data). */
export async function redactEuOrders(db: PrismaClient, shopDomain: string, orderIds: (string | number)[]) {
  if (!orderIds.length) return;
  const shop = await db.shop.findUnique({ where: { domain: shopDomain } });
  if (!shop) return;
  const gids = orderIds.map((id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Order/${id}`));
  await db.euOrder.deleteMany({ where: { shopId: shop.id, orderId: { in: gids } } });
}
