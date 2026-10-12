// Send the codes to whoever files EU customs: pick the provider, follow its steps,
// copy manufacturer codes into barcodes (Zonos/Passport), download the customs file,
// or print the codes for an order.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { PROVIDERS, providerById } from "../lib/providers";
import { barcodeSyncCandidates, recentEuOrders, shipStatus } from "../lib/ship.server";
import { euFilterOn } from "../lib/eu-orders.server";
import { EU_WINDOW_DAYS } from "../lib/constants";
import { enqueue } from "../lib/jobs.server";
import { JobProgress, downloadFile } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const [status, sync, orders, job] = await Promise.all([
    shipStatus(prisma, shop.id),
    barcodeSyncCandidates(prisma, shop.id),
    recentEuOrders(prisma, shop.id),
    prisma.job.findFirst({ where: { shopId: shop.id, type: "barcode_sync", status: { in: ["queued", "running"] } } }),
  ]);
  return {
    provider: shop.settings.provider,
    status,
    syncCount: sync.ids.length,
    syncWithoutBarcode: sync.withoutBarcode,
    orders,
    euOn: euFilterOn(shop),
    euStatus: shop.euSyncStatus,
    runningJob: job?.id ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "provider") {
    const id = String(form.get("provider") ?? "");
    if (id === "" || providerById(id)) await prisma.settings.update({ where: { shopId: ctx.shop.id }, data: { provider: id } });
    return { ok: true };
  }
  if (intent === "sync-barcodes") {
    const busy = await prisma.job.findFirst({ where: { shopId: ctx.shop.id, type: "barcode_sync", status: { in: ["queued", "running"] } } });
    if (busy) return { jobId: busy.id };
    const { ids } = await barcodeSyncCandidates(prisma, ctx.shop.id);
    if (!ids.length) return { error: "Every manufacturer code is already in the barcodes." };
    const job = await enqueue(prisma, ctx.shop.id, "barcode_sync", { variantIds: ids }, ctx.actor, ids.length);
    return { jobId: job.id };
  }
  return { error: "Unknown action" };
};

const fmt = (n: number) => n.toLocaleString("en-US");

export default function Ship() {
  const d = useLoaderData<typeof loader>();
  const saving = useFetcher();
  const { revalidate } = useRevalidator();
  const fetcher = useFetcher<{ jobId?: string; error?: string }>();
  const p = providerById(d.provider);
  const jobId = fetcher.data?.jobId ?? d.runningJob;
  const scope = d.euOn ? "eu" : "all";

  return (
    <s-page heading="Send codes to your shipping provider">
      <s-stack gap="base">
        <s-section>
          <s-stack gap="small-200">
            <s-paragraph>
              Customs never sees your Shopify store. It gets the codes inside the customs data that your carrier, shipping app or broker sends for each parcel.
              They are not printed on the shipping label. So the last step is making sure whoever files your customs can read them.
            </s-paragraph>
            <s-text color="subdued">
              {fmt(d.status.ready)} of {fmt(d.status.inScope)} items are ready. Items that aren’t ready are still sent with whatever codes they have.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="1. Who files customs for your EU parcels?">
          <div role="radiogroup" aria-label="Who files customs for your EU parcels">
            <s-stack gap="small">
              {PROVIDERS.map((x) => (
                <label key={x.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer", padding: "6px 0" }}>
                  <input type="radio" name="provider" value={x.id} defaultChecked={d.provider === x.id} style={{ marginTop: 3 }}
                    onChange={() => saving.submit({ intent: "provider", provider: x.id }, { method: "post" })} />
                  <span>
                    <strong style={{ fontWeight: 600 }}>{x.name}</strong>
                    <br />
                    <span style={{ color: "#616161" }}>{x.short}</span>
                  </span>
                </label>
              ))}
              {saving.state !== "idle" && <s-text color="subdued">Saving…</s-text>}
            </s-stack>
          </div>
        </s-section>

        {p && (
          <s-section heading={`2. What ${p.name.split(" (")[0]} needs`}>
            <s-stack gap="base">
              <s-ordered-list>
                {p.steps.map((st) => (
                  <s-list-item key={st}>{st}</s-list-item>
                ))}
              </s-ordered-list>

              {p.barcodes !== "no" && (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-stack gap="small-200">
                    <s-text type="strong">Copy manufacturer codes to barcodes</s-text>
                    <s-text color="subdued">
                      {fmt(d.status.inBarcodes)} of {fmt(d.status.withNspid)} manufacturer codes are already in the barcode list.
                      {d.syncCount ? ` ${fmt(d.syncCount)} to copy.` : ""}
                    </s-text>
                    {d.syncWithoutBarcode > 0 && (
                      <s-text color="subdued">
                        {fmt(d.syncWithoutBarcode)} of these items have no barcode, so the manufacturer code becomes their first barcode. Sales channels like Google Shopping read the first barcode and may show a warning for these.
                      </s-text>
                    )}
                    {fetcher.data?.error && <s-text tone="critical">{fetcher.data.error}</s-text>}
                    {jobId ? (
                      <JobProgress jobId={jobId} onDone={() => revalidate()} />
                    ) : (
                      <div>
                        <s-button
                          variant={p.barcodes === "recommended" ? "primary" : "secondary"}
                          disabled={d.syncCount === 0 || undefined}
                          onClick={() => fetcher.submit({ intent: "sync-barcodes" }, { method: "post" })}
                        >
                          {d.syncCount ? `Copy ${fmt(d.syncCount)} codes` : "All copied"}
                        </s-button>
                      </div>
                    )}
                  </s-stack>
                </s-box>
              )}
            </s-stack>
          </s-section>
        )}

        <s-section heading={p ? "3. Download or print" : "Download or print"}>
          <s-stack gap="base">
            <s-stack gap="small-200">
              <s-text type="strong">Customs file</s-text>
              <s-text color="subdued">
                One row per item with the three codes, HS code and country of origin. For brokers, Global-e, or anyone who asks “send me your product identifiers”.
                {d.euOn ? ` Only items shipped to the EU in the last ${EU_WINDOW_DAYS} days.` : ""}
              </s-text>
              <s-stack direction="inline" gap="small">
                <s-button onClick={() => downloadFile(`/app/ship/file?format=standard&scope=${scope}`, "eu-customs-codes.csv")}>Download customs file</s-button>
                <s-button variant="tertiary" onClick={() => downloadFile(`/app/ship/file?format=shipping_app&scope=${scope}`, "eu-customs-codes-shipping-app.csv")}>
                  Shipping-app format (m_pid, ns_pid, s_pid)
                </s-button>
              </s-stack>
            </s-stack>
            <s-divider />
            <s-stack gap="small-200">
              <s-text type="strong">Print the codes</s-text>
              <s-text color="subdued">For staff who type shipments into a carrier website by hand, or to attach to a commercial invoice. Customs doesn’t require a printout.</s-text>
              <div>
                <s-button href={`/app/ship/print?all=1`}>Print list of {d.euOn ? "EU items" : "all items"}</s-button>
              </div>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Recent EU orders">
          {d.orders.length === 0 ? (
            <s-paragraph>
              {d.euStatus === "ok"
                ? `No orders shipped to EU countries in the last ${EU_WINDOW_DAYS} days.`
                : "Order access isn’t set up yet, so we can’t list EU orders. Approve order access when Shopify asks."}
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Order</s-table-header>
                <s-table-header>Country</s-table-header>
                <s-table-header>Date</s-table-header>
                <s-table-header>Items ready</s-table-header>
                <s-table-header>Codes</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {d.orders.map((o) => (
                  <s-table-row key={o.orderId}>
                    <s-table-cell>{o.name}</s-table-cell>
                    <s-table-cell>{o.country}</s-table-cell>
                    <s-table-cell>{new Date(o.createdAt).toLocaleDateString()}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={o.ready === o.items ? "success" : "warning"}>
                        {o.ready} of {o.items}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={`/app/ship/print?order=${encodeURIComponent(o.orderId)}`}>Print</s-link>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
