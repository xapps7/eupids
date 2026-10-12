// UC-03 browse and filter issues; UC-05 bulk "no barcode"; UC-06 export; UC-07 request from selection.
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import { filterOptions, listIssues, parseFilters } from "../lib/issues.server";
import { euFilter } from "../lib/eu-shipping.server";
import { enqueue } from "../lib/jobs.server";
import { checkFixGate, upgradeResponse } from "../lib/gate.server";
import { JobProgress, RULE_LABEL, SEVERITY_TONE, downloadFile } from "../components/ui";
import { Checkbox, Mono, Select, TextField } from "../components/wc";
import { UpgradePrompt, type Upgrade } from "../components/UpgradePrompt";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const f = parseFilters(url);
  const eu = await euFilter(prisma, { ...shop, settings: { euOnly: true } });
  const euAvailable = eu.on;
  const euShown = euAvailable && url.searchParams.get("scope") !== "all";
  if (euShown) f.euDefault = shop.euDefaultShips;
  const [list, opts] = await Promise.all([listIssues(prisma, shop.id, f), filterOptions(prisma, shop.id)]);
  return { ...list, opts, filters: f, euAvailable, euShown };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const ids = String(form.get("ids") ?? "").split(",").filter(Boolean);
  if (intent === "no-barcode") {
    const plan = await syncPlan(ctx);
    const gate = await checkFixGate(ctx.shop.id, plan, ids);
    if (!gate.ok) return upgradeResponse(gate, "/app/issues?code=R-SPID-01");
    // Only variants of this shop that really have no barcode.
    const valid = await prisma.issue.findMany({
      where: { shopId: ctx.shop.id, variantId: { in: ids }, ruleCode: "R-SPID-01", status: "open" },
      select: { variantId: true },
    });
    if (!valid.length) return { error: "None of the selected items are missing a barcode." };
    const job = await enqueue(prisma, ctx.shop.id, "no_barcode_bulk", { variantIds: valid.map((v) => v.variantId) }, ctx.actor, valid.length);
    return { jobId: job.id };
  }
  return { error: "Unknown action" };
};

const CODE_OPTIONS = [
  { value: "", label: "All problems" },
  ...Object.entries(RULE_LABEL).map(([value, label]) => ({ value, label: `${label} (${value})` })),
];

export default function Issues() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  const fetcher = useFetcher<{ jobId?: string; error?: string; upgrade?: Upgrade }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState(params.get("q") ?? "");
  const [confirming, setConfirming] = useState(false);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("cursor");
    setParams(next);
    setSelected(new Set());
  };
  const code = params.get("code") ?? "";
  const allIds = useMemo(() => data.rows.map((r) => r.variantId), [data.rows]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const toggle = (id: string, on: boolean) => {
    const n = new Set(selected);
    if (on) n.add(id);
    else n.delete(id);
    setSelected(n);
  };
  const ids = [...selected].join(",");
  const noBarcodeMode = code === "R-SPID-01";

  return (
    <s-page heading="Items to fix">
      <s-button slot="primary-action" onClick={() => downloadFile(`/app/issues/export${selected.size ? `?ids=${encodeURIComponent(ids)}` : ""}`, "pid-ready-issues.csv")}>
        Export issues CSV
      </s-button>
      <s-button slot="secondary-actions" href="/app/import">Upload fixed CSV</s-button>

      <s-stack gap="base">
        {fetcher.data?.upgrade && <UpgradePrompt upgrade={fetcher.data.upgrade} />}
        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {fetcher.data?.jobId && <JobProgress jobId={fetcher.data.jobId} onDone={() => revalidate()} />}

        {data.euAvailable && (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text color="subdued">
              {data.euShown ? "Showing only items your shipping settings let you send to the EU." : "Showing all items."}
            </s-text>
            <s-button variant="tertiary" onClick={() => set("scope", data.euShown ? "all" : "")}>
              {data.euShown ? "Show all items" : "Show only EU items"}
            </s-button>
          </s-stack>
        )}

        <s-section>
          <s-query-container><s-grid gridTemplateColumns="@container (inline-size > 800px) 2fr 1fr 1fr 1fr 1fr, 1fr" gap="small" alignItems="end">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                set("q", q.trim());
              }}
            >
              <TextField label="Search title, SKU or barcode" value={q} onValue={setQ} placeholder="Press Enter to search" />
            </form>
            <Select label="Problem" value={code} onValue={(v) => set("code", v)} options={CODE_OPTIONS} />
            <Select
              label="Severity"
              value={params.get("severity") ?? ""}
              onValue={(v) => set("severity", v)}
              options={[{ value: "", label: "All" }, { value: "error", label: "Errors" }, { value: "warning", label: "Warnings" }, { value: "info", label: "Info" }]}
            />
            <Select label="Vendor" value={params.get("vendor") ?? ""} onValue={(v) => set("vendor", v)} options={[{ value: "", label: "All vendors" }, ...data.opts.vendors.map((v) => ({ value: v, label: v }))]} />
            <Select
              label="Status"
              value={params.get("status") ?? "open"}
              onValue={(v) => set("status", v === "open" ? "" : v)}
              options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]}
            />
          </s-grid></s-query-container>
          {data.opts.types.length > 1 && (
            <div style={{ marginTop: 8, maxWidth: 260 }}>
              <Select label="Product type" value={params.get("type") ?? ""} onValue={(v) => set("type", v)} options={[{ value: "", label: "All types" }, ...data.opts.types.map((t) => ({ value: t, label: t }))]} />
            </div>
          )}
        </s-section>

        {selected.size > 0 && (
          <s-section>
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{selected.size} selected</s-text>
              {noBarcodeMode && (
                <s-button variant="primary" onClick={() => setConfirming(true)}>These have no barcode</s-button>
              )}
              <s-button href={`/app/suppliers/new?ids=${encodeURIComponent(ids)}`}>Request from supplier</s-button>
              <s-button variant="tertiary" onClick={() => setSelected(new Set())}>Clear</s-button>
            </s-stack>
            {!noBarcodeMode && <s-text color="subdued">Filter by “Barcode missing” to confirm items have no barcode.</s-text>}
          </s-section>
        )}

        {confirming && (
          <s-banner tone="warning" heading={`Confirm ${selected.size} items have no barcode`}>
            <s-paragraph>You confirm these items have no GTIN, EAN, UPC or ISBN. Customs will get exception code Y081 for them.</s-paragraph>
            <s-stack direction="inline" gap="small">
              <s-button
                variant="primary"
                onClick={() => {
                  fetcher.submit({ intent: "no-barcode", ids }, { method: "post" });
                  setConfirming(false);
                  setSelected(new Set());
                }}
              >
                Yes, none exists
              </s-button>
              <s-button variant="tertiary" onClick={() => setConfirming(false)}>Cancel</s-button>
            </s-stack>
          </s-banner>
        )}

        <s-section padding="none">
          {data.rows.length === 0 ? (
            <s-box padding="large">
              <s-heading>{params.toString() ? "No items match these filters" : "Nothing to fix. You’re ready."}</s-heading>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>
                  <Checkbox hideLabel label="Select all on this page" checked={allSelected} onChecked={(on) => setSelected(on ? new Set(allIds) : new Set())} />
                </s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Vendor</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Barcode</s-table-header>
                <s-table-header>Manufacturer code</s-table-header>
                <s-table-header>Problems</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.rows.map((r) => (
                  <s-table-row key={r.variantId}>
                    <s-table-cell>
                      <Checkbox hideLabel label="Select" checked={selected.has(r.variantId)} onChecked={(on) => toggle(r.variantId, on)} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small" alignItems="center">
                        {r.imageUrl ? <s-thumbnail src={r.imageUrl} alt="" size="small" /> : null}
                        <s-stack gap="none">
                          <s-link href={`/app/variants/${encodeURIComponent(r.variantId)}`}>{r.productTitle}</s-link>
                          {r.variantTitle ? <s-text color="subdued">{r.variantTitle}</s-text> : null}
                        </s-stack>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{r.vendor || "—"}</s-table-cell>
                    <s-table-cell>{r.sku ? <Mono>{r.sku}</Mono> : <s-text color="subdued">empty</s-text>}</s-table-cell>
                    <s-table-cell>
                      {r.barcodes[0] ? <Mono>{r.barcodes[0]}</Mono> : r.noStandardIdentifier ? <s-badge>None (Y081)</s-badge> : <s-text color="subdued">empty</s-text>}
                    </s-table-cell>
                    <s-table-cell>{r.nspid ? <Mono>{r.nspid}</Mono> : <s-text color="subdued">empty</s-text>}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        {r.issues.map((i) => (
                          <s-badge key={i.ruleCode} tone={SEVERITY_TONE[i.severity as keyof typeof SEVERITY_TONE]}>
                            {RULE_LABEL[i.ruleCode] ?? i.ruleCode}
                          </s-badge>
                        ))}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        <s-stack direction="inline" gap="small" justifyContent="end">
          {params.get("cursor") && (
            <s-button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("cursor");
                setParams(next);
              }}
            >
              First page
            </s-button>
          )}
          {data.nextCursor && (
            <s-button
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("cursor", data.nextCursor!);
                setParams(next);
                setSelected(new Set());
              }}
            >
              Next 50
            </s-button>
          )}
        </s-stack>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
