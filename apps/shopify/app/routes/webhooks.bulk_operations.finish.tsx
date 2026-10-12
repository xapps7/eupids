// UC-01: bulk operation finished → stream results, evaluate. Polling is the fallback (worker).
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { firstDelivery } from "../lib/webhooks.server";
import { onBulkFinish } from "../lib/scan.server";
import { gqlForShop } from "../lib/context.server";
import { log } from "../lib/log.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: domain, topic, payload, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(prisma, webhookId, domain, topic))) return new Response();
  const shop = await prisma.shop.findUnique({ where: { domain } });
  const opId = (payload as any)?.admin_graphql_api_id as string | undefined;
  if (!shop || !opId) return new Response();
  void (async () => {
    try {
      await onBulkFinish(prisma, await gqlForShop(domain), shop.id, opId);
    } catch (e) {
      log.error("bulk_finish_failed", { shopId: shop.id, err: String(e) });
    }
  })();
  return new Response();
};
