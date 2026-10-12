// UC-15 / Section 10: plans and the Shopify-hosted approval flow.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import { PLANS, planById, type PlanId } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await adminContext(request);
  const plan = await syncPlan(ctx, true).catch(() => ctx.shop.plan as PlanId);
  const inScope = await prisma.variantSnapshot.count({ where: { shopId: ctx.shop.id, inScope: true } });
  return {
    current: plan,
    inScope,
    trialUsed: ctx.shop.trialUsed,
    plans: PLANS.map((p) => ({ ...p, cap: Number.isFinite(p.cap) ? p.cap : null })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await adminContext(request);
  const form = await request.formData();
  const planId = String(form.get("plan")) as PlanId;
  const next = String(form.get("next") || "/app");
  const safeNext = next.startsWith("/app") ? next : "/app";
  const p = planById(planId);
  if (!p || p.price === 0) return { error: "Choose a paid plan." };

  if (ctx.dev || !ctx.billing) {
    // Local dev: simulate approval.
    await prisma.shop.update({ where: { id: ctx.shop.id }, data: { plan: p.id, trialUsed: true } });
    return redirect(safeNext);
  }
  // Shopify-hosted approval. 7-day trial once per shop.
  const appUrl = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  await ctx.billing.request({
    plan: p.name,
    isTest: process.env.BILLING_TEST !== "false",
    returnUrl: `${appUrl}/app/billing/return?next=${encodeURIComponent(safeNext)}`,
    ...(ctx.shop.trialUsed ? { trialDays: 0 } : {}),
  } as any);
  return null; // billing.request throws a redirect
};

export default function Billing() {
  const { current, inScope, plans, trialUsed } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const fetcher = useFetcher<{ error?: string }>();
  const suggested = params.get("plan");
  const next = params.get("next") ?? "/app";

  return (
    <s-page heading="Plans">
      <s-stack gap="base">
        <s-paragraph>
          Scanning, the dashboard, every issue and the readiness report are free forever. Paid plans unlock fixing. Your store has {inScope.toLocaleString()} variants in scope.
        </s-paragraph>
        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        <s-query-container><s-grid gridTemplateColumns="@container (inline-size > 900px) repeat(4, 1fr), @container (inline-size > 520px) 1fr 1fr, 1fr" gap="base">
          {plans.map((p) => {
            const isCurrent = p.id === current;
            const tooSmall = p.cap !== null && inScope > p.cap;
            return (
              <s-section key={p.id}>
                <s-stack gap="small">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-heading>{p.name}</s-heading>
                    {isCurrent ? <s-badge tone="success">Current</s-badge> : suggested === p.id ? <s-badge tone="info">Suggested</s-badge> : null}
                  </s-stack>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>
                    ${p.price}
                    <span style={{ fontSize: 14, fontWeight: 400 }}> / month</span>
                  </div>
                  <s-unordered-list>
                    {p.features.map((f) => (
                      <s-list-item key={f}>{f}</s-list-item>
                    ))}
                  </s-unordered-list>
                  {p.price > 0 && !isCurrent && (
                    <fetcher.Form method="post">
                      <input type="hidden" name="plan" value={p.id} />
                      <input type="hidden" name="next" value={next} />
                      <s-button type="submit" variant={suggested === p.id ? "primary" : "secondary"} {...(tooSmall ? { disabled: true } : {})}>
                        {tooSmall ? "Too small for your store" : trialUsed ? `Choose ${p.name}` : `Start 7-day trial`}
                      </s-button>
                    </fetcher.Form>
                  )}
                </s-stack>
              </s-section>
            );
          })}
        </s-grid></s-query-container>
        <s-text color="subdued">Billed by Shopify in USD. Cancel any time from your Shopify admin.</s-text>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
