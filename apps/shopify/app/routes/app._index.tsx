// UC-02 Dashboard (+ UC-01 scanning screen, UC-14 rescan, E-14 banner, UC-12 guard banner).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { dashboardSummary } from "../lib/evaluate.server";
import { lastGoodScan, latestScan, startScan } from "../lib/scan.server";
import { daysLeft, downloadFile, usePolling } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const [scan, good] = await Promise.all([latestScan(prisma, shop.id), lastGoodScan(prisma, shop.id)]);
  const summary = good ? await dashboardSummary(prisma, shop.id) : null;
  return {
    scan: scan && { status: scan.status, startedAt: scan.startedAt.toISOString(), error: scan.error },
    good: good && { finishedAt: good.finishedAt?.toISOString() ?? null, total: good.variantsTotal },
    summary,
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
  if (intent === "dismiss-eu") await prisma.settings.update({ where: { shopId: shop.id }, data: { euBannerDismissed: true } });
  if (intent === "dismiss-guard") await prisma.shop.update({ where: { id: shop.id }, data: { guardAlert: false } });
  return { ok: true };
};

const fmt = (n: number) => n.toLocaleString("en-US");

function IdCard(props: { code: string; title: string; help: string; c: { missing: number; invalid: number; ok: number }; missingRule: string; invalidLabel: string; invalidRules: string }) {
  const total = Math.max(1, props.c.ok + props.c.invalid + props.c.missing);
  return (
    <s-section>
      <s-stack gap="small-200">
        <s-text color="subdued">{props.code}</s-text>
        <s-heading>{props.title}</s-heading>
        <s-text color="subdued">{props.help}</s-text>
        <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#eee", margin: "6px 0" }}>
          <div style={{ width: `${(props.c.ok / total) * 100}%`, background: "#29845a" }} />
          <div style={{ width: `${(props.c.invalid / total) * 100}%`, background: "#b28400" }} />
          <div style={{ width: `${(props.c.missing / total) * 100}%`, background: "#c70a24" }} />
        </div>
        <s-stack direction="inline" justifyContent="space-between">
          <s-text>OK</s-text>
          <s-text type="strong">{fmt(props.c.ok)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          <s-link href={`/app/issues?code=${props.invalidRules}`}>{props.invalidLabel}</s-link>
          <s-text type="strong">{fmt(props.c.invalid)}</s-text>
        </s-stack>
        <s-stack direction="inline" justifyContent="space-between">
          <s-link href={`/app/issues?code=${props.missingRule}`}>Missing</s-link>
          <s-text type="strong">{fmt(props.c.missing)}</s-text>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function Dashboard() {
  const { scan, good, summary, showEuBanner, guardAlert, mappingRequired } = useLoaderData<typeof loader>();
  const running = scan?.status === "running" || scan?.status === "queued";
  usePolling(running);
  const days = daysLeft();

  const rescan = (
    <Form method="post">
      <input type="hidden" name="intent" value="rescan" />
      <s-button type="submit" {...(running ? { disabled: true, loading: true } : {})}>
        {running ? "Scanning…" : "Rescan"}
      </s-button>
    </Form>
  );

  // UC-01: first scan in progress.
  if (!good && running) {
    return (
      <s-page heading="Scanning your catalogue">
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-spinner accessibilityLabel="Scanning" size="large" />
            <s-heading>Checking every product for EU customs IDs</s-heading>
            <s-paragraph>Most stores finish in under 3 minutes. You can leave this page; the scan keeps running.</s-paragraph>
          </s-stack>
        </s-section>
      </s-page>
    );
  }
  // UC-01 A1: failed with nothing to show.
  if (!good) {
    return (
      <s-page heading="PID Ready">
        <s-banner tone="critical" heading="Scan failed, try again">
          {scan?.error ? <s-paragraph>{scan.error}</s-paragraph> : null}
          {rescan}
        </s-banner>
      </s-page>
    );
  }

  const s = summary!;
  return (
    <s-page heading="EU customs readiness">
      <s-stack slot="primary-action" direction="inline" gap="small">
        {rescan}
      </s-stack>
      <s-stack gap="base">
        {mappingRequired && (
          <s-banner tone="warning" heading="Choose where manufacturer codes live">
            <s-paragraph>Your store already has a field called customs.manufacturer_product_id with a different type. Pick the field to use in Settings before fixing items.</s-paragraph>
            <s-button href="/app/settings">Open Settings</s-button>
          </s-banner>
        )}
        {guardAlert && (
          <s-banner tone="warning" heading="A product that was ready now has problems">
            <s-paragraph>New or edited products were checked automatically. Review them in Issues.</s-paragraph>
            <Form method="post" style={{ display: "inline" }}>
              <input type="hidden" name="intent" value="dismiss-guard" />
              <s-button type="submit" variant="tertiary">Dismiss</s-button>
            </Form>
          </s-banner>
        )}
        {showEuBanner && (
          <s-banner tone="info" heading="You may not need this">
            <s-paragraph>Your store doesn’t ship to any EU country right now. These IDs only matter for parcels to EU shoppers.</s-paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="dismiss-eu" />
              <s-button type="submit" variant="tertiary">Dismiss</s-button>
            </Form>
          </s-banner>
        )}
        {scan?.status === "failed" && (
          <s-banner tone="warning" heading="The latest scan failed">
            <s-paragraph>Showing results from the last good scan. Try Rescan.</s-paragraph>
          </s-banner>
        )}

        {s.inScope === 0 ? (
          <s-section heading="Nothing to check">
            <s-paragraph>
              We check active products that need shipping. Gift cards, digital items and drafts are skipped. {good.total ? `We found ${fmt(good.total)} variants, none in scope.` : "Your store has no products yet."}
            </s-paragraph>
          </s-section>
        ) : (
          <>
            <s-query-container>
            <s-grid gridTemplateColumns="@container (inline-size > 900px) 1fr 2fr, 1fr" gap="base">
              <s-section>
                <s-stack gap="small-200">
                  <s-text color="subdued">Readiness score</s-text>
                  <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{s.score}%</div>
                  <s-text>{fmt(s.ready)} of {fmt(s.inScope)} variants are ready.</s-text>
                  {s.outOfScope > 0 && <s-text color="subdued">{fmt(s.outOfScope)} skipped (draft, gift card or not shipped).</s-text>}
                  <s-divider />
                  <s-text>{days === null ? "Now enforced" : `${days} days to 1 Nov 2026`}</s-text>
                  <s-text color="subdued">Last scan {good.finishedAt ? new Date(good.finishedAt).toLocaleString() : "—"}</s-text>
                  <s-stack direction="inline" gap="small">
                    <s-button href="/app/issues">Fix issues</s-button>
                    <s-button variant="tertiary" onClick={() => downloadFile("/app/report", "pid-ready-report.csv")}>Export report</s-button>
                  </s-stack>
                </s-stack>
              </s-section>
              <s-query-container><s-grid gridTemplateColumns="@container (inline-size > 560px) 1fr 1fr 1fr, 1fr" gap="base">
                <IdCard code="M-PID" title="Your SKU" help="Must exist and be unique" c={s.mpid} missingRule="R-MPID-01" invalidLabel="Duplicate" invalidRules="R-MPID-02" />
                <IdCard code="NS-PID" title="Manufacturer code" help="The maker’s model or part number" c={s.nspid} missingRule="R-NSPID-01" invalidLabel="Invalid" invalidRules="R-NSPID-04" />
                <IdCard code="S-PID" title="Barcode" help="GTIN, EAN, UPC or ISBN, if one exists" c={s.spid} missingRule="R-SPID-01" invalidLabel="Invalid" invalidRules="R-SPID-02,R-SPID-03,R-SPID-04,R-SPID-05" />
              </s-grid></s-query-container>
            </s-grid>
            </s-query-container>

            <s-section heading="Vendors missing manufacturer codes">
              {s.topVendorsMissingNspid.length === 0 ? (
                <s-paragraph>Every vendor has manufacturer codes.</s-paragraph>
              ) : (
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Vendor</s-table-header>
                    <s-table-header format="numeric">Missing</s-table-header>
                    <s-table-header>Action</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {s.topVendorsMissingNspid.map((v) => (
                      <s-table-row key={v.vendor}>
                        <s-table-cell>{v.vendor}</s-table-cell>
                        <s-table-cell>{fmt(v.count)}</s-table-cell>
                        <s-table-cell>
                          <s-button variant="secondary" href={`/app/suppliers/new?vendor=${encodeURIComponent(v.vendor)}`}>Request codes</s-button>
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}
            </s-section>

            <s-section heading="Issues by type">
              <s-table>
                <s-table-header-row>
                  <s-table-header>Severity</s-table-header>
                  <s-table-header>What to fix</s-table-header>
                  <s-table-header format="numeric">Variants</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {s.byRule.map((r) => (
                    <s-table-row key={r.code}>
                      <s-table-cell>
                        <s-badge tone={r.severity === "error" ? "critical" : r.severity === "warning" ? "warning" : "info"}>{r.severity}</s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-link href={`/app/issues?code=${r.code}`}>{r.message}</s-link>
                      </s-table-cell>
                      <s-table-cell>{fmt(r.variants)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </s-section>
          </>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
