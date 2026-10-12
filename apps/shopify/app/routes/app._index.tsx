// UC-02 Dashboard (+ UC-01 scanning screen, UC-14 rescan, E-14 banner, UC-12 guard banner).
// Written for a merchant who has never heard of "PIDs": what the rule is, how ready they are,
// and the next thing to do, in that order. When order data is available it shows only the
// items they actually ship to EU shoppers.
import type { ReactNode } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { dashboardSummary } from "../lib/evaluate.server";
import { lastGoodScan, latestScan, queueEuSync, startScan } from "../lib/scan.server";
import { euFilterOn, euVariantIds } from "../lib/eu-orders.server";
import { EU_WINDOW_DAYS } from "../lib/constants";
import { PROVIDERS } from "../lib/providers";
import { CODES, daysLeft, downloadFile, usePolling } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const [scan, good, euJob] = await Promise.all([
    latestScan(prisma, shop.id),
    lastGoodScan(prisma, shop.id),
    prisma.job.findFirst({ where: { shopId: shop.id, type: "eu_sync", status: { in: ["queued", "running"] } } }),
  ]);
  const euOn = euFilterOn(shop);
  const only = euOn ? await euVariantIds(prisma, shop.id) : null;
  const summary = good ? await dashboardSummary(prisma, shop.id, only) : null;
  const allCount = good && euOn ? await prisma.variantSnapshot.count({ where: { shopId: shop.id, inScope: true } }) : null;
  return {
    scan: scan && { status: scan.status, startedAt: scan.startedAt.toISOString(), error: scan.error },
    good: good && { finishedAt: good.finishedAt?.toISOString() ?? null, total: good.variantsTotal },
    summary,
    allCount,
    eu: {
      on: euOn,
      wanted: shop.settings.euOnly,
      status: euJob ? "running" : shop.euSyncStatus,
      orders: shop.euOrderCount,
      syncedAt: shop.euSyncedAt?.toISOString() ?? null,
    },
    provider: PROVIDERS.find((p) => p.id === shop.settings.provider)?.name ?? null,
    showEuBanner: shop.sellsToEu === false && !shop.settings.euBannerDismissed,
    guardAlert: shop.guardAlert,
    mappingRequired: shop.settings.mappingRequired,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, gql } = await adminContext(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "rescan") await startScan(prisma, gql, shop.id);
  if (intent === "eu-refresh") await queueEuSync(prisma, shop.id);
  if (intent === "eu-only") await prisma.settings.update({ where: { shopId: shop.id }, data: { euOnly: form.get("value") === "true" } });
  if (intent === "dismiss-eu") await prisma.settings.update({ where: { shopId: shop.id }, data: { euBannerDismissed: true } });
  if (intent === "dismiss-guard") await prisma.shop.update({ where: { id: shop.id }, data: { guardAlert: false } });
  return { ok: true };
};

const fmt = (n: number) => n.toLocaleString("en-US");
const items = (n: number) => `${fmt(n)} item${n === 1 ? "" : "s"}`;

function Hidden({ intent, value }: { intent: string; value?: string }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      {value !== undefined && <input type="hidden" name="value" value={value} />}
    </>
  );
}

/** One of the three codes: what it is, where it lives in Shopify, how many are fine. */
function CodeCard(props: { code: (typeof CODES)[keyof typeof CODES]; c: { missing: number; invalid: number; ok: number }; missingRule: string; invalidLabel: string; invalidRules: string }) {
  const total = Math.max(1, props.c.ok + props.c.invalid + props.c.missing);
  return (
    <s-section>
      <s-stack gap="small-200">
        <s-heading>{props.code.name}</s-heading>
        <s-text color="subdued">{props.code.what}</s-text>
        <s-text color="subdued">In Shopify: {props.code.where}</s-text>
        <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#eee", margin: "6px 0" }}>
          <div style={{ width: `${(props.c.ok / total) * 100}%`, background: "#29845a" }} />
          <div style={{ width: `${(props.c.invalid / total) * 100}%`, background: "#b28400" }} />
          <div style={{ width: `${(props.c.missing / total) * 100}%`, background: "#c70a24" }} />
        </div>
        <s-stack direction="inline" justifyContent="space-between">
          <s-text>Good</s-text>
          <s-text type="strong">{fmt(props.c.ok)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          {props.c.invalid ? <s-link href={`/app/issues?code=${props.invalidRules}`}>{props.invalidLabel}</s-link> : <s-text>{props.invalidLabel}</s-text>}
          <s-text type="strong">{fmt(props.c.invalid)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          {props.c.missing ? <s-link href={`/app/issues?code=${props.missingRule}`}>Missing</s-link> : <s-text>Missing</s-text>}
          <s-text type="strong">{fmt(props.c.missing)}</s-text>
        </s-stack>
        <s-text color="subdued">Customs name: {props.code.customs}</s-text>
      </s-stack>
    </s-section>
  );
}

type Step = { done: boolean; title: string; detail: string; actions: { label: string; href: string; primary?: boolean }[] };

function NextSteps({ steps }: { steps: Step[] }) {
  const firstOpen = steps.findIndex((s) => !s.done);
  return (
    <s-section heading="What to do next">
      <s-stack gap="base">
        {steps.map((s, i) => (
          <div key={s.title} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 12, alignItems: "start" }}>
            <div
              aria-hidden="true"
              style={{
                width: 28, height: 28, borderRadius: 14, display: "grid", placeItems: "center", fontWeight: 650, fontSize: 13,
                background: s.done ? "#29845a" : i === firstOpen ? "#303030" : "#e3e3e3", color: s.done || i === firstOpen ? "#fff" : "#616161",
              }}
            >
              {s.done ? "✓" : i + 1}
            </div>
            <s-stack gap="small-200">
              <s-text type="strong">{s.title}</s-text>
              <s-text color="subdued">{s.detail}</s-text>
              {!s.done && s.actions.length > 0 && (
                <s-stack direction="inline" gap="small">
                  {s.actions.map((a) => (
                    <s-button key={a.label} href={a.href} variant={a.primary && i === firstOpen ? "primary" : "secondary"}>{a.label}</s-button>
                  ))}
                </s-stack>
              )}
            </s-stack>
          </div>
        ))}
      </s-stack>
    </s-section>
  );
}

export default function Dashboard() {
  const { scan, good, summary, allCount, eu, provider, showEuBanner, guardAlert, mappingRequired } = useLoaderData<typeof loader>();
  const running = scan?.status === "running" || scan?.status === "queued";
  usePolling(running || eu.status === "running");
  const days = daysLeft();

  const rescan = (
    <Form method="post">
      <Hidden intent="rescan" />
      <s-button type="submit" {...(running ? { disabled: true, loading: true } : {})}>
        {running ? "Checking…" : "Check again"}
      </s-button>
    </Form>
  );

  // UC-01: first scan in progress.
  if (!good && running) {
    return (
      <s-page heading="PID Ready">
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Checking" size="large" />
            <s-heading>Checking every product for the codes EU customs needs</s-heading>
            <s-paragraph>Most stores finish in under 3 minutes. You can leave this page; the check keeps running.</s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    );
  }
  // UC-01 A1: failed with nothing to show.
  if (!good) {
    return (
      <s-page heading="PID Ready">
        <s-banner tone="critical" heading="The check failed. Try again.">
          {scan?.error ? <s-paragraph>{scan.error}</s-paragraph> : null}
          {rescan}
        </s-banner>
      </s-page>
    );
  }

  const s = summary!;
  const rule = (code: string) => s.byRule.find((r) => r.code === code)?.variants ?? 0;
  const scopeWord = eu.on ? "items you ship to the EU" : "items";
  const missingBarcode = rule("R-SPID-01");
  const badBarcode = s.spid.invalid + rule("R-SPID-04");
  const skuProblems = s.mpid.missing + s.mpid.invalid;

  const steps: Step[] = [
    {
      done: s.nspid.missing + s.nspid.invalid === 0,
      title: s.nspid.missing ? `Add manufacturer codes to ${items(s.nspid.missing)}` : "Manufacturer codes",
      detail: s.nspid.missing
        ? "Shopify has no field for this, so most stores have none. Your suppliers know them. Send each supplier a link and approve what they enter, or type them in yourself."
        : s.nspid.invalid
          ? `${items(s.nspid.invalid)} have a manufacturer code that needs a fix.`
          : "Every item has one.",
      actions: [
        { label: "Ask suppliers", href: "/app/suppliers/new", primary: true },
        { label: "Fix in list", href: `/app/issues?code=${s.nspid.missing ? "R-NSPID-01" : "R-NSPID-04,R-NSPID-05"}` },
      ],
    },
    {
      done: missingBarcode + badBarcode === 0,
      title: missingBarcode
        ? `Add a barcode, or confirm there is none, for ${items(missingBarcode)}`
        : badBarcode
          ? `Fix ${items(badBarcode)} with a wrong barcode`
          : "Barcodes",
      detail: missingBarcode
        ? "Customs wants the barcode (EAN, UPC) if the item has one. Handmade or unbranded items often don't. Then you tick “no barcode” and customs gets code Y081 instead."
        : badBarcode
          ? "These look like typos, fake numbers or internal codes. Customs checks the digits."
          : "Every item has a valid barcode or is marked as having none.",
      actions: [{ label: missingBarcode ? "Review items" : "Fix barcodes", href: `/app/issues?code=${missingBarcode ? "R-SPID-01" : "R-SPID-02,R-SPID-03,R-SPID-04,R-SPID-05,R-SPID-06,R-SPID-07"}`, primary: true }],
    },
    {
      done: skuProblems === 0,
      title: skuProblems ? `Fix the SKU on ${items(skuProblems)}` : "SKUs",
      detail: skuProblems ? "Each item needs its own SKU. Missing or repeated SKUs confuse customs." : "Every item has its own SKU.",
      actions: [{ label: "Fix SKUs", href: `/app/issues?code=${s.mpid.missing ? "R-MPID-01" : "R-MPID-02"}`, primary: true }],
    },
    {
      done: false,
      title: "Send the codes to your shipping provider",
      detail: provider
        ? `You use ${provider}. See how they pick up the codes, download the customs file, or print codes for an order.`
        : "Customs gets the codes from whoever files your parcels: your carrier, shipping app or broker. Pick yours to see what they need.",
      actions: [{ label: provider ? "Open" : "Choose provider", href: "/app/ship", primary: true }],
    },
  ];

  return (
    <s-page heading="PID Ready">
      <s-stack slot="primary-action" direction="inline" gap="small">
        {rescan}
      </s-stack>
      <s-stack gap="base">
        {mappingRequired && (
          <s-banner tone="warning" heading="Choose where manufacturer codes are saved">
            <s-paragraph>Your store already has a field called customs.manufacturer_product_id with a different type. Pick the field to use in Settings before fixing items.</s-paragraph>
            <s-button href="/app/settings">Open Settings</s-button>
          </s-banner>
        )}
        {guardAlert && (
          <s-banner tone="warning" heading="A product that was ready now has a problem">
            <s-paragraph>New and edited products are checked automatically. One of them is now missing a code. Review it in Issues.</s-paragraph>
            <Form method="post" style={{ display: "inline" }}>
              <Hidden intent="dismiss-guard" />
              <s-button type="submit" variant="tertiary">Dismiss</s-button>
            </Form>
          </s-banner>
        )}
        {showEuBanner && (
          <s-banner tone="info" heading="You may not need this">
            <s-paragraph>Your store doesn’t ship to any EU country right now. These codes only matter for parcels to EU shoppers.</s-paragraph>
            <Form method="post">
              <Hidden intent="dismiss-eu" />
              <s-button type="submit" variant="tertiary">Dismiss</s-button>
            </Form>
          </s-banner>
        )}
        {scan?.status === "failed" && (
          <s-banner tone="warning" heading="The latest check failed">
            <s-paragraph>Showing results from the last good check. Try “Check again”.</s-paragraph>
          </s-banner>
        )}

        <s-section>
          <s-stack gap="small-200">
            <s-heading>From 1 November 2026, EU customs needs 3 codes for every item you ship to EU shoppers</s-heading>
            <s-paragraph>
              The codes are your SKU, the manufacturer’s own code, and the barcode. Your carrier sends them with each parcel’s customs data. Nothing is printed on the label.
              If a code is missing or wrong, customs can hold the parcel. PID Ready finds the gaps, helps you fill them, and gets the codes to your shipping provider.
            </s-paragraph>
            <s-text type="strong">{days === null ? "The rule applies now." : `${days} day${days === 1 ? "" : "s"} left.`}</s-text>
          </s-stack>
        </s-section>

        <EuScope eu={eu} allCount={allCount} />

        {s.inScope === 0 ? (
          <s-section heading="Nothing to check">
            <s-paragraph>
              We check active products that need shipping. Gift cards, digital items and drafts are skipped. {good.total ? `We found ${items(good.total)}, none to check.` : "Your store has no products yet."}
            </s-paragraph>
          </s-section>
        ) : (
          <>
            <s-section>
              <s-stack gap="small-200">
                <s-text color="subdued">Ready for EU customs</s-text>
                <s-stack direction="inline" gap="base" alignItems="end">
                  <div style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{fmt(s.ready)}</div>
                  <div style={{ paddingBottom: 6 }}>
                    <s-text>of {items(s.inScope)} ({s.score ?? 0}%)</s-text>
                  </div>
                </s-stack>
                <div style={{ height: 8, borderRadius: 4, background: "#eee", overflow: "hidden" }} role="img" aria-label={`${s.score ?? 0}% ready`}>
                  <div style={{ width: `${s.score ?? 0}%`, height: "100%", background: "#29845a" }} />
                </div>
                <s-text color="subdued">
                  An item is one product option, like a size or colour. “Ready” means all 3 codes are there and look right.
                  {s.outOfScope > 0 ? ` ${items(s.outOfScope)} skipped (drafts, gift cards, digital).` : ""}
                </s-text>
                <s-text color="subdued">Last checked {good.finishedAt ? new Date(good.finishedAt).toLocaleString() : "—"}</s-text>
              </s-stack>
            </s-section>

            <NextSteps steps={steps} />

            <s-query-container>
              <s-grid gridTemplateColumns="@container (inline-size > 760px) 1fr 1fr 1fr, 1fr" gap="base">
                <CodeCard code={CODES.mpid} c={s.mpid} missingRule="R-MPID-01" invalidLabel="Repeated" invalidRules="R-MPID-02" />
                <CodeCard code={CODES.nspid} c={s.nspid} missingRule="R-NSPID-01" invalidLabel="Needs a fix" invalidRules="R-NSPID-04,R-NSPID-05" />
                <CodeCard code={CODES.spid} c={s.spid} missingRule="R-SPID-01" invalidLabel="Wrong" invalidRules="R-SPID-02,R-SPID-03,R-SPID-04,R-SPID-05" />
              </s-grid>
            </s-query-container>

            {s.topVendorsMissingNspid.length > 0 && (
              <s-section heading="Suppliers to ask for manufacturer codes">
                <s-paragraph>These vendors make the most {scopeWord} without a manufacturer code. Send each one a link; they fill in a simple form, you approve.</s-paragraph>
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Vendor</s-table-header>
                    <s-table-header format="numeric">Items missing a code</s-table-header>
                    <s-table-header>Action</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {s.topVendorsMissingNspid.map((v) => (
                      <s-table-row key={v.vendor}>
                        <s-table-cell>{v.vendor}</s-table-cell>
                        <s-table-cell>{fmt(v.count)}</s-table-cell>
                        <s-table-cell>
                          <s-button variant="secondary" href={`/app/suppliers/new?vendor=${encodeURIComponent(v.vendor)}`}>Ask for codes</s-button>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-section>
            )}

            {s.byRule.length > 0 && (
              <s-section heading="Every problem we found">
                <s-table>
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Problem</s-table-header>
                    <s-table-header>How serious</s-table-header>
                    <s-table-header format="numeric">Items</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {s.byRule.map((r) => (
                      <s-table-row key={r.code}>
                        <s-table-cell>
                          <s-link href={`/app/issues?code=${r.code}`}>{r.message}</s-link>
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge tone={r.severity === "error" ? "critical" : r.severity === "warning" ? "warning" : "info"}>
                            {r.severity === "error" ? "Blocks customs" : r.severity === "warning" ? "Should fix" : "Note"}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>{fmt(r.variants)}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
                <s-stack direction="inline" gap="small">
                  <s-button variant="tertiary" onClick={() => downloadFile("/app/report", "pid-ready-report.csv")}>Download full report (CSV)</s-button>
                </s-stack>
              </s-section>
            )}
          </>
        )}
      </s-stack>
    </s-page>
  );
}

/** Which items the numbers cover: only EU-shipped ones (from orders) or the whole catalogue. */
function EuScope({ eu, allCount }: { eu: { on: boolean; wanted: boolean; status: string | null; orders: number; syncedAt: string | null }; allCount: number | null }) {
  const toggle = (value: boolean, label: string) => (
    <Form method="post">
      <Hidden intent="eu-only" value={String(value)} />
      <s-button type="submit" variant="tertiary">{label}</s-button>
    </Form>
  );
  const refresh = (
    <Form method="post">
      <Hidden intent="eu-refresh" />
      <s-button type="submit" variant="tertiary">Try again</s-button>
    </Form>
  );
  let body: ReactNode;
  if (eu.status === "running") {
    body = (
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-spinner accessibilityLabel="Reading orders" size="base" />
        <s-text>Finding which products you ship to the EU… Showing all products for now.</s-text>
      </s-stack>
    );
  } else if (eu.on) {
    body = (
      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
        <s-text>
          Showing only products you shipped to EU shoppers in the last {EU_WINDOW_DAYS} days ({fmt(eu.orders)} order{eu.orders === 1 ? "" : "s"}).
          {allCount !== null ? ` Your store has ${items(allCount)} in total.` : ""}
        </s-text>
        {toggle(false, "Show all products")}
      </s-stack>
    );
  } else if (eu.status === "ok" && eu.orders === 0) {
    body = <s-text>No orders to EU countries in the last {EU_WINDOW_DAYS} days, so we show all products. Fix the ones you plan to sell to the EU.</s-text>;
  } else if (eu.status === "ok" && !eu.wanted) {
    body = (
      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
        <s-text>Showing all products. {fmt(eu.orders)} EU order{eu.orders === 1 ? "" : "s"} in the last {EU_WINDOW_DAYS} days.</s-text>
        {toggle(true, "Show only products shipped to the EU")}
      </s-stack>
    );
  } else if (eu.status === "no_access") {
    body = (
      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
        <s-text>Showing all products. To show only what you ship to the EU, PID Ready needs to read orders (country and items only, never names or addresses). Approve it when Shopify asks.</s-text>
        {refresh}
      </s-stack>
    );
  } else if (eu.status === "failed") {
    body = (
      <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
        <s-text>We couldn’t read your EU orders. Showing all products.</s-text>
        {refresh}
      </s-stack>
    );
  } else {
    body = <s-text>Showing all products.</s-text>;
  }
  return <s-section>{body}</s-section>;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
