// One entry point for every admin route: authenticate, load the shop, give back a Gql client.
// Local dev mode (PID_DEV_SHOP set, never in production) swaps Shopify for the in-memory fake,
// so every screen can be exercised without a store.
import prisma from "../db.server";
import { authenticate, offlineGql } from "../shopify.server";
import { fromAdmin, type Gql } from "./gql.server";
import { getShop } from "./shop.server";
import { FakeShopify, seedDemo } from "./fake-shopify.server";
import { onInstalled } from "./install.server";
import { onBulkFinish } from "./scan.server";
import { planByName, type PlanId } from "./plans";
import { log } from "./log.server";

declare global {
  // eslint-disable-next-line no-var
  var __pidFake: FakeShopify | undefined;
}

export const DEV_SHOP = process.env.NODE_ENV !== "production" ? process.env.PID_DEV_SHOP : undefined;

export function devFake(): FakeShopify {
  if (!global.__pidFake) {
    global.__pidFake = new FakeShopify();
    seedDemo(global.__pidFake, Number(process.env.PID_DEV_VARIANTS ?? 60));
  }
  return global.__pidFake;
}

/** In dev mode, bulk operations "finish" right away, like the webhook would. */
function devGql(): Gql {
  const f = devFake();
  return async (q, v) => {
    const res: any = await f.gql(q, v);
    if (/mutation RunScan/.test(q) && res?.bulkOperationRunQuery?.bulkOperation?.id) {
      const opId = res.bulkOperationRunQuery.bulkOperation.id;
      setTimeout(async () => {
        const shop = await prisma.shop.findUnique({ where: { domain: DEV_SHOP! } });
        if (shop) await onBulkFinish(prisma, devGql(), shop.id, opId).catch((e) => log.error("dev_bulk", { err: String(e) }));
      }, 1500);
    }
    return res;
  };
}

export async function gqlForShop(domain: string): Promise<Gql> {
  if (DEV_SHOP && domain === DEV_SHOP) return devGql();
  return offlineGql(domain);
}

export type BillingApi = Awaited<ReturnType<typeof authenticate.admin>>["billing"] | null;

export async function adminContext(request: Request) {
  if (DEV_SHOP) {
    let shop = await getShop(prisma, DEV_SHOP);
    if (!(await prisma.scan.findFirst({ where: { shopId: shop.id } }))) {
      await onInstalled(prisma, DEV_SHOP, devGql());
      shop = await getShop(prisma, DEV_SHOP);
    }
    return { shop, gql: devGql(), billing: null as BillingApi, actor: "user:dev", dev: true };
  }
  const { admin, session, billing, sessionToken } = await authenticate.admin(request);
  const shop = await getShop(prisma, session.shop);
  const actor = `user:${sessionToken?.sub ?? session.onlineAccessInfo?.associated_user?.id ?? "merchant"}`;
  return { shop, gql: fromAdmin(admin), billing: billing as BillingApi, actor, dev: false };
}

export type AdminContext = Awaited<ReturnType<typeof adminContext>>;

/** Section 10: plan state comes only from Shopify. Checked on load at most every 10 minutes. */
export async function syncPlan(ctx: AdminContext, force = false): Promise<PlanId> {
  if (ctx.dev || !ctx.billing) return ctx.shop.plan as PlanId;
  const fresh = ctx.shop.planCheckedAt && Date.now() - ctx.shop.planCheckedAt.getTime() < 10 * 60_000;
  if (fresh && !force) return ctx.shop.plan as PlanId;
  const res = await ctx.billing.check({ isTest: process.env.BILLING_TEST !== "false" } as any);
  const active = res.appSubscriptions.find((s: any) => s.status === "ACTIVE");
  const plan = (active ? planByName(active.name)?.id : "free") ?? "free";
  await prisma.shop.update({
    where: { id: ctx.shop.id },
    data: { plan, planCheckedAt: new Date(), ...(active ? { trialUsed: true } : {}) },
  });
  ctx.shop.plan = plan;
  return plan;
}
