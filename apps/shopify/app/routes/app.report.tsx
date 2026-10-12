// UC-13: readiness report CSV (free on every plan).
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { readinessReportCsv } from "../lib/csv.server";
import { csvResponse } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const csv = await readinessReportCsv(prisma, shop.id);
  return csvResponse(csv, `pid-ready-report-${new Date().toISOString().slice(0, 10)}.csv`);
};
