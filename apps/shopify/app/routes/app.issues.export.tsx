// UC-06 step 1: export open issues as CSV (optionally only selected variants).
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { exportIssuesCsv } from "../lib/csv.server";
import { csvResponse } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const ids = new URL(request.url).searchParams.get("ids");
  const csv = await exportIssuesCsv(prisma, shop.id, ids ? ids.split(",").filter(Boolean) : undefined);
  return csvResponse(csv, `pid-ready-issues-${new Date().toISOString().slice(0, 10)}.csv`);
};
