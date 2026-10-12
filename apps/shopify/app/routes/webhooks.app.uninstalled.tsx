// UC-16: mark inactive, revoke supplier links, stop jobs, cancel scans (E-12).
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { firstDelivery, onUninstalled } from "../lib/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  if (!(await firstDelivery(prisma, webhookId, shop, topic))) return new Response();
  // The access token is already revoked, so the bulk operation can't be cancelled via API.
  await onUninstalled(prisma, null, shop);
  return new Response();
};
