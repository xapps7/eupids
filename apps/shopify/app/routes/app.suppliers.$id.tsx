// UC-09: review and apply a supplier submission (diff view, approve selected/all, reject).
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import * as supplier from "../lib/supplier.server";
import { checkFixGate, upgradeResponse } from "../lib/gate.server";
import { JobProgress, downloadFile, toast } from "../components/ui";
import { Checkbox, Mono } from "../components/wc";
import { UpgradePrompt, type Upgrade } from "../components/UpgradePrompt";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const data = await supplier.reviewRows(prisma, shop.id, params.id!);
  if (!data) throw new Response("Not found", { status: 404 });
  const items = await prisma.supplierRequestItem.count({ where: { requestId: params.id! } });
  const r = data.request;
  return {
    request: {
      id: r.id,
      supplierName: r.supplierName,
      supplierEmail: r.supplierEmail,
      expiresAt: r.expiresAt.toISOString(),
      state: r.revoked ? "revoked" : r.expiresAt.getTime() < Date.now() ? "expired" : "active",
      items,
    },
    rows: data.rows.map((x) => ({
      id: x.submission.id,
      title: x.title,
      sku: x.sku,
      exists: x.exists,
      valid: x.valid,
      status: x.submission.reviewStatus,
      submittedAt: x.submission.submittedAt.toISOString(),
      current: x.current,
      next: { nspid: x.submission.nspid ?? "", barcode: x.submission.barcode ?? "", noBarcode: x.submission.noBarcode },
    })),
  };
};

type Result = { jobId?: string; rejected?: number; token?: string; link?: string; error?: string; upgrade?: Upgrade; revoked?: boolean };

export const action = async ({ request, params }: ActionFunctionArgs): Promise<Result> => {
  const ctx = await adminContext(request);
  const body = (await request.json()) as { intent: string; ids?: string[] };
  const id = params.id!;
  if (body.intent === "approve") {
    const plan = await syncPlan(ctx);
    const subs = await prisma.supplierSubmission.findMany({ where: { id: { in: body.ids ?? [] }, requestId: id }, select: { variantId: true } });
    const gate = await checkFixGate(ctx.shop.id, plan, subs.map((s) => s.variantId));
    if (!gate.ok) return upgradeResponse(gate, `/app/suppliers/${id}`);
    const job = await supplier.approve(prisma, ctx.shop.id, id, body.ids ?? [], ctx.actor);
    return job ? { jobId: job.id } : { error: "Nothing to approve. Items that no longer exist can’t be approved." };
  }
  if (body.intent === "reject") return { rejected: await supplier.reject(prisma, ctx.shop.id, id, body.ids ?? [], ctx.actor) };
  if (body.intent === "revoke") {
    await supplier.revoke(prisma, ctx.shop.id, id, ctx.actor);
    return { revoked: true };
  }
  if (body.intent === "rotate") {
    const token = await supplier.rotateToken(prisma, ctx.shop.id, id, ctx.actor);
    return { token, link: supplier.supplierLink(token) };
  }
  return { error: "Unknown action" };
};

const Diff = ({ from, to }: { from: string; to: string }) =>
  from === to ? <Mono>{to || "—"}</Mono> : (
    <span>
      <s-text color="subdued">{from || "empty"}</s-text> → <Mono>{to || "—"}</Mono>
    </span>
  );

export default function RequestDetail() {
  const { request, rows } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<Result>();
  const { revalidate } = useRevalidator();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const pending = rows.filter((r) => r.status === "pending" && r.exists);
  const post = (intent: string, ids?: string[]) => fetcher.submit({ intent, ids } as any, { method: "post", encType: "application/json" });
  const selIds = [...sel];

  return (
    <s-page heading={request.supplierName}>
      <s-link slot="breadcrumb-actions" href="/app/suppliers">Suppliers</s-link>
      <s-button slot="primary-action" variant="primary" {...(!pending.length ? { disabled: true } : {})} onClick={() => post("approve", pending.map((r) => r.id))}>
        Approve all ({pending.length})
      </s-button>
      <s-button slot="secondary-actions" onClick={() => downloadFile(`/app/suppliers/${request.id}/items`, "items.csv")}>Item list CSV</s-button>

      <s-stack gap="base">
        {fetcher.data?.upgrade && <UpgradePrompt upgrade={fetcher.data.upgrade} />}
        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {fetcher.data?.jobId && <JobProgress jobId={fetcher.data.jobId} onDone={() => revalidate()} />}
        {fetcher.data?.link && (
          <s-banner tone="success" heading="New link created. The old link no longer works.">
            <code style={{ wordBreak: "break-all" }}>{fetcher.data.link}</code>
            <s-button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(fetcher.data!.link!);
                  toast("Copied");
                } catch {
                  toast("Select the link and copy it", true);
                }
              }}
            >
              Copy link
            </s-button>
          </s-banner>
        )}

        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-stack gap="none">
              <s-text>
                {request.items} items · link <s-badge tone={request.state === "active" ? "success" : "neutral"}>{request.state}</s-badge>
              </s-text>
              <s-text color="subdued">
                {request.state === "active" ? `Expires ${new Date(request.expiresAt).toLocaleDateString()}` : "The supplier can’t open this link."}
                {request.supplierEmail ? ` · ${request.supplierEmail}` : ""}
              </s-text>
            </s-stack>
            <s-stack direction="inline" gap="small">
              <s-button onClick={() => post("rotate")}>{request.state === "active" ? "Create a new link" : "Reopen with a new link"}</s-button>
              {request.state === "active" && (
                <s-button tone="critical" variant="tertiary" onClick={() => post("revoke")}>Revoke link</s-button>
              )}
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Submissions" padding="none">
          {rows.length === 0 ? (
            <s-box padding="base">
              <s-paragraph>No submissions yet. Send the link to your supplier, or create a new link if you lost it.</s-paragraph>
            </s-box>
          ) : (
            <>
              {sel.size > 0 && (
                <s-box padding="base">
                  <s-stack direction="inline" gap="small">
                    <s-button variant="primary" onClick={() => post("approve", selIds)}>Approve selected ({sel.size})</s-button>
                    <s-button tone="critical" onClick={() => post("reject", selIds)}>Reject selected</s-button>
                  </s-stack>
                </s-box>
              )}
              <s-table>
                <s-table-header-row>
                  <s-table-header>Select</s-table-header>
                  <s-table-header listSlot="primary">Item</s-table-header>
                  <s-table-header>Manufacturer code</s-table-header>
                  <s-table-header>Barcode</s-table-header>
                  <s-table-header>Status</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rows.map((r) => (
                    <s-table-row key={r.id}>
                      <s-table-cell>
                        {r.status === "pending" && r.exists ? (
                          <Checkbox
                            hideLabel
                            label="Select"
                            checked={sel.has(r.id)}
                            onChecked={(on) => {
                              const n = new Set(sel);
                              if (on) n.add(r.id);
                              else n.delete(r.id);
                              setSel(n);
                            }}
                          />
                        ) : null}
                      </s-table-cell>
                      <s-table-cell>
                        <s-stack gap="none">
                          <s-text>{r.title}</s-text>
                          <s-text color="subdued">SKU {r.sku || "—"}</s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <Diff from={r.current.nspid} to={r.next.nspid || r.current.nspid} />
                      </s-table-cell>
                      <s-table-cell>
                        {r.next.noBarcode && !r.next.barcode ? (
                          <span>
                            <s-text color="subdued">{r.current.barcode || "empty"}</s-text> → <s-badge>None (Y081)</s-badge>
                          </span>
                        ) : (
                          <Diff from={r.current.barcode} to={r.next.barcode || r.current.barcode} />
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        {!r.exists ? (
                          <s-badge tone="critical">Variant no longer exists</s-badge>
                        ) : !r.valid ? (
                          <s-badge tone="critical">Invalid</s-badge>
                        ) : (
                          <s-badge tone={r.status === "approved" ? "success" : r.status === "rejected" ? "neutral" : "warning"}>{r.status === "pending" ? "To review" : r.status}</s-badge>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
