// The customs file: every item with its three codes (standard or shipping-app column names).
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { customsFileCsv, type CustomsFormat } from "../lib/csv.server";
import { euVariantIds } from "../lib/eu-orders.server";
import { csvResponse } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const format: CustomsFormat = url.searchParams.get("format") === "shipping_app" ? "shipping_app" : "standard";
  const only = url.searchParams.get("scope") === "eu" ? await euVariantIds(prisma, shop.id) : null;
  const csv = await customsFileCsv(prisma, shop.id, { format, only: only && only.size ? only : null });
  const day = new Date().toISOString().slice(0, 10);
  return csvResponse(csv, `eu-customs-codes${format === "shipping_app" ? "-shipping-app" : ""}-${day}.csv`);
};
