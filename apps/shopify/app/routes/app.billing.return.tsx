// UC-15: after Shopify approval, refresh the plan from Shopify and resume where the merchant was.
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { adminContext, syncPlan } from "../lib/context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await adminContext(request);
  await syncPlan(ctx, true);
  const next = new URL(request.url).searchParams.get("next") ?? "/app";
  return redirect(next.startsWith("/app") ? next : "/app");
};
