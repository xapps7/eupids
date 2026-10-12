// Mandatory compliance webhooks. PID Ready stores no customer details (no names, emails,
// phones or addresses). It keeps a short list of recent EU order numbers with their line items
// for the print sheet; customers/redact deletes the listed orders from it.
// shop/redact deletes every row for the shop (UC-16, AT-17).
import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { redactShop } from "../lib/webhooks.server";
import { redactEuOrders } from "../lib/eu-orders.server";
import { log } from "../lib/log.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  switch (String(topic).toUpperCase().replace("/", "_")) {
    case "SHOP_REDACT":
      await redactShop(prisma, shop);
      log.info("shop_redacted", { shop });
      break;
    case "CUSTOMERS_REDACT":
      await redactEuOrders(prisma, shop, ((payload as any)?.orders_to_redact ?? []) as (string | number)[]);
      break;
    case "CUSTOMERS_DATA_REQUEST":
    default:
      break;
  }
  return new Response();
};
