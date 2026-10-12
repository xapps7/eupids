// UC-06: upload the edited issues CSV → preview → apply in the background.
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import { itemsFromPreview, previewImport, type ImportPreview } from "../lib/csv.server";
import { enqueue } from "../lib/jobs.server";
import { checkFixGate, upgradeResponse } from "../lib/gate.server";
import { JobProgress, downloadFile } from "../components/ui";
import { UpgradePrompt, type Upgrade } from "../components/UpgradePrompt";

const MAX_BYTES = 15 * 1024 * 1024;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await adminContext(request);
  return null;
};

type Result = { preview?: ImportPreview; jobId?: string; error?: string; upgrade?: Upgrade };

export const action = async ({ request }: ActionFunctionArgs): Promise<Result> => {
  const ctx = await adminContext(request);
  const body = (await request.json()) as { intent: "preview" | "apply"; text: string; mode?: "valid_fields" | "skip_rows"; fileName?: string };
  if (!body.text || body.text.length > MAX_BYTES) return { error: "Choose a CSV file under 15 MB." };
  const preview = await previewImport(prisma, ctx.shop.id, body.text);
  if (preview.headerError) return { error: preview.headerError };
  if (body.intent === "preview") return { preview };

  const items = itemsFromPreview(preview, body.mode ?? "skip_rows");
  const plan = await syncPlan(ctx);
  const gate = await checkFixGate(ctx.shop.id, plan, items.map((i) => i.variantId));
  if (!gate.ok) return upgradeResponse(gate, "/app/import");
  if (!items.length) return { error: "Nothing to apply." };
  const job = await enqueue(
    prisma,
    ctx.shop.id,
    "csv_apply",
    {
      items,
      fileName: body.fileName,
      // Keep preview problems so the failures CSV lists them too.
      preview: { withErrors: body.mode === "valid_fields" ? preview.withErrors.filter((r) => !Object.keys(r.validChanges).length) : preview.withErrors, unknown: preview.unknown },
    },
    ctx.actor,
    items.length,
  );
  return { jobId: job.id };
};

const FIELD: Record<string, string> = { sku: "SKU", barcode: "Barcode", nspid: "Manufacturer code", noStandardIdentifier: "No barcode", hsCode: "HS code", countryOfOrigin: "Origin" };
const show = (v: unknown) => (v === null || v === "" ? "(empty)" : String(v));

export default function Import() {
  const fetcher = useFetcher<Result>();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<"valid_fields" | "skip_rows">("skip_rows");
  const busy = fetcher.state !== "idle";
  const p = fetcher.data?.preview;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const t = await file.text();
    setText(t);
    setFileName(file.name);
    fetcher.submit({ intent: "preview", text: t, fileName: file.name }, { method: "post", encType: "application/json" });
  };

  return (
    <s-page heading="Upload fixed CSV">
      <s-link slot="breadcrumb-actions" href="/app/issues">Issues</s-link>
      <s-stack gap="base">
        <s-section heading="1. Export, edit, upload">
          <s-paragraph>
            Export the issues CSV, fill in the sku, barcode, ns_pid, no_standard_identifier, hs_code or country_of_origin columns, then upload it here. Other columns are ignored.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-button onClick={() => downloadFile("/app/issues/export", "pid-ready-issues.csv")}>Export issues CSV</s-button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.currentTarget.files?.[0])} />
            </label>
          </s-stack>
        </s-section>

        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {fetcher.data?.upgrade && <UpgradePrompt upgrade={fetcher.data.upgrade} />}
        {busy && !p && <s-banner tone="info" heading="Checking your file…" />}
        {fetcher.data?.jobId && <JobProgress jobId={fetcher.data.jobId} />}

        {p && !fetcher.data?.jobId && (
          <s-section heading={`2. Preview: ${fileName}`}>
            <s-grid gridTemplateColumns="repeat(4, 1fr)" gap="base">
              <s-box padding="base" background="subdued" borderRadius="base"><s-text color="subdued">Rows to change</s-text><s-heading>{p.toChange.length}</s-heading></s-box>
              <s-box padding="base" background="subdued" borderRadius="base"><s-text color="subdued">Rows with errors</s-text><s-heading>{p.withErrors.length}</s-heading></s-box>
              <s-box padding="base" background="subdued" borderRadius="base"><s-text color="subdued">Unchanged</s-text><s-heading>{p.unchanged}</s-heading></s-box>
              <s-box padding="base" background="subdued" borderRadius="base"><s-text color="subdued">Unknown variants</s-text><s-heading>{p.unknown.length}</s-heading></s-box>
            </s-grid>

            {p.withErrors.length > 0 && (
              <s-stack gap="small">
                <s-heading>Rows with errors</s-heading>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Line</s-table-header>
                    <s-table-header>Item</s-table-header>
                    <s-table-header>Problem</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {p.withErrors.slice(0, 50).map((r) => (
                      <s-table-row key={r.line}>
                        <s-table-cell>{r.line}</s-table-cell>
                        <s-table-cell>{r.title}</s-table-cell>
                        <s-table-cell>{Object.entries(r.errors).map(([f, m]) => `${FIELD[f] ?? f}: ${m}`).join(" · ")}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
                <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
                  <legend style={{ fontWeight: 600, marginBottom: 4 }}>For rows with errors</legend>
                  <label style={{ display: "flex", gap: 8 }}>
                    <input type="radio" name="mode" checked={mode === "skip_rows"} onChange={() => setMode("skip_rows")} /> Skip these rows
                  </label>
                  <label style={{ display: "flex", gap: 8 }}>
                    <input type="radio" name="mode" checked={mode === "valid_fields"} onChange={() => setMode("valid_fields")} /> Apply the valid fields only
                  </label>
                </fieldset>
              </s-stack>
            )}

            {p.toChange.length > 0 && (
              <s-stack gap="small">
                <s-heading>Changes (first 50)</s-heading>
                <s-table>
                  <s-table-header-row>
                    <s-table-header>Item</s-table-header>
                    <s-table-header>Changes</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {p.toChange.slice(0, 50).map((r) => (
                      <s-table-row key={r.line}>
                        <s-table-cell>{r.title}</s-table-cell>
                        <s-table-cell>{Object.entries(r.changes).map(([f, v]) => `${FIELD[f] ?? f} → ${show(v)}`).join(" · ")}</s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            )}

            {p.unknown.length > 0 && <s-banner tone="warning">{p.unknown.length} rows have a variant_id that isn’t in your store. They will be skipped.</s-banner>}

            <s-stack direction="inline" gap="small">
              <s-button
                variant="primary"
                {...(busy || (!p.toChange.length && !(mode === "valid_fields" && p.withErrors.length)) ? { disabled: true } : {})}
                onClick={() => fetcher.submit({ intent: "apply", text: text!, mode, fileName }, { method: "post", encType: "application/json" })}
              >
                Apply changes
              </s-button>
            </s-stack>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
