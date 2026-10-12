// UC-12 / FR-12: guard new and edited products. HMAC is verified by authenticate.webhook;
// duplicates are dropped by webhook id. Work runs after we reply so Shopify gets a fast 200.
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { firstDelivery, guardProduct } from "../lib/webhooks.server";
import { gqlForShop } from "../lib/context.server";
import { log } from "../lib/log.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop: domain, topic, payload, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(prisma, webhookId, domain, topic))) return new Response();
  const shop = await prisma.shop.findUnique({ where: { domain } });
  const productGid = (payload as any)?.admin_graphql_api_id as string | undefined;
  if (!shop?.active || !productGid) return new Response();
  // Skip while a full scan is running; the scan will pick this product up.
  void (async () => {
    try {
      const gql = await gqlForShop(domain);
      await guardProduct(prisma, gql, shop.id, productGid);
    } catch (e) {
      log.error("guard_failed", { shopId: shop.id, topic, err: String(e) });
    }
  })();
  return new Response();
};
