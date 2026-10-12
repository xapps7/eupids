// Section 10: plan state comes only from Shopify.
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { firstDelivery } from "../lib/webhooks.server";
import { planByName } from "../lib/plans";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(prisma, webhookId, shop, topic))) return new Response();
  const sub = (payload as any)?.app_subscription ?? {};
  const status = String(sub.status ?? "").toUpperCase();
  const plan = status === "ACTIVE" ? (planByName(String(sub.name ?? ""))?.id ?? "free") : "free";
  await prisma.shop.updateMany({
    where: { domain: shop },
    data: { plan, planCheckedAt: new Date(), ...(status === "ACTIVE" ? { trialUsed: true } : {}) },
  });
  return new Response();
};
