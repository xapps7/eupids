import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { queueEuSync } from "../lib/scan.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, shop } = await authenticate.webhook(request);
  const current = payload.current as string[];
  if (session) {
    await db.session.update({ where: { id: session.id }, data: { scope: current.toString() } });
  }
  // The merchant just approved order access: build the EU view now.
  if (current.includes("read_orders")) {
    const row = await db.shop.findUnique({ where: { domain: shop } });
    if (row?.active) await queueEuSync(db, row.id);
  }
  return new Response();
};
