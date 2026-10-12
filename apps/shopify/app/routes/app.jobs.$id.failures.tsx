// UC-06: downloadable CSV of failures for a job.
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { failuresCsv } from "../lib/csv.server";
import { csvResponse } from "../components/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const job = await prisma.job.findFirst({ where: { id: params.id, shopId: shop.id } });
  if (!job) throw new Response("Not found", { status: 404 });
  const payload = job.payload as any;
  const csv = failuresCsv(payload?.preview ?? null, (job.failures as any) ?? []);
  return csvResponse(csv, `pid-ready-failures-${job.id}.csv`);
};
