// FR-08: job progress for polling.
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const job = await prisma.job.findFirst({
    where: { id: params.id, shopId: shop.id },
    select: { id: true, status: true, total: true, done: true, failed: true, type: true },
  });
  return { job };
};
