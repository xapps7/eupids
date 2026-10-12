import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import { pendingCount } from "../lib/supplier.server";
import { DISCLAIMER } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await adminContext(request);
  const plan = await syncPlan(ctx).catch(() => ctx.shop.plan);
  const pending = await pendingCount(prisma, ctx.shop.id);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", dev: ctx.dev, plan, pending };
};

const NAV = [
  { href: "/app", label: "Dashboard" },
  { href: "/app/issues", label: "Issues" },
  { href: "/app/suppliers", label: "Suppliers" },
  { href: "/app/ship", label: "Send codes" },
  { href: "/app/settings", label: "Settings" },
  { href: "/app/billing", label: "Plans" },
];

export default function App() {
  const { apiKey, dev, pending } = useLoaderData<typeof loader>();
  const label = (n: (typeof NAV)[number]) => (n.label === "Suppliers" && pending ? `Suppliers (${pending})` : n.label);

  return (
    <AppProvider embedded={!dev} apiKey={apiKey}>
      {dev ? (
        <nav style={{ display: "flex", gap: 16, padding: "10px 16px", borderBottom: "1px solid #ddd", fontFamily: "system-ui", fontSize: 14, background: "#fff" }}>
          <strong>PID Ready · local dev</strong>
          {NAV.map((n) => (
            <Link key={n.href} to={n.href}>{label(n)}</Link>
          ))}
        </nav>
      ) : (
        <s-app-nav>
          {NAV.map((n) => (
            <s-link key={n.href} href={n.href} {...(n.href === "/app" ? { rel: "home" } : {})}>
              {label(n)}
            </s-link>
          ))}
        </s-app-nav>
      )}
      <Outlet />
      <div style={{ padding: "24px 16px 32px", textAlign: "center" }}>
        <s-text color="subdued">{DISCLAIMER}</s-text>
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
