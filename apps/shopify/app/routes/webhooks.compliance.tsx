// Mandatory compliance webhooks. PID Ready stores no customer data, so the customer topics
// have nothing to return or delete. shop/redact deletes every row for the shop (UC-16, AT-17).
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { redactShop } from "../lib/webhooks.server";
import { log } from "../lib/log.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  switch (String(topic).toUpperCase().replace("/", "_")) {
    case "SHOP_REDACT":
      await redactShop(prisma, shop);
      log.info("shop_redacted", { shop });
      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    default:
      break;
  }
  return new Response();
};
