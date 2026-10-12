// UC-07: CSV of the items in a request (for the merchant to attach or forward).
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { supplierCsv } from "../lib/supplier.server";
import { csvResponse } from "../components/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const req = await prisma.supplierRequest.findFirst({ where: { id: params.id, shopId: shop.id } });
  if (!req) throw new Response("Not found", { status: 404 });
  return csvResponse(await supplierCsv(prisma, req), `items-${req.supplierName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`);
};
