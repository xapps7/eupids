// Send the codes to whoever files EU customs. The merchant ticks every provider they use;
// each gets a card with how the codes reach it, exact steps, and the one-click action or file.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { GROUPS, PROVIDERS, parseProviders, providerById, type Provider, type ProviderAction } from "../lib/providers";
import { allWithNspid, barcodeSyncCandidates, shipStatus } from "../lib/ship.server";
import { euFilter } from "../lib/eu-shipping.server";
import { enqueue } from "../lib/jobs.server";
import { JobProgress, downloadFile } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const [status, sync, job, eu] = await Promise.all([
    shipStatus(prisma, shop.id),
    barcodeSyncCandidates(prisma, shop.id),
    prisma.job.findFirst({ where: { shopId: shop.id, type: "barcode_sync", status: { in: ["queued", "running"] } }, orderBy: { createdAt: "desc" } }),
    euFilter(prisma, shop),
  ]);
  return {
    selected: parseProviders(shop.settings.provider),
    nspidBarcode: shop.settings.nspidBarcode,
    status,
    syncCount: sync.ids.length,
    syncWithoutBarcode: sync.withoutBarcode,
    euOn: eu.on,
    runningJob: job?.id ?? null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const ctx = await adminContext(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "providers") {
    const ids = String(form.get("providers") ?? "").split(",").filter((x) => providerById(x));
    await prisma.settings.update({ where: { shopId: ctx.shop.id }, data: { provider: ids.join(",") } });
    return { ok: true };
  }
  if (intent === "publish" || intent === "flavorcloud") {
    const busy = await prisma.job.findFirst({ where: { shopId: ctx.shop.id, type: "barcode_sync", status: { in: ["queued", "running"] } } });
    if (busy) return { jobId: busy.id };
    const flavorcloud = intent === "flavorcloud";
    const ids = flavorcloud ? await allWithNspid(prisma, ctx.shop.id) : (await barcodeSyncCandidates(prisma, ctx.shop.id)).ids;
    if (!ids.length) return { error: flavorcloud ? "No manufacturer codes yet. Add some first." : "Every manufacturer code is already in Shopify." };
    if (!flavorcloud && !ctx.shop.settings.nspidBarcode) {
      await prisma.settings.update({ where: { shopId: ctx.shop.id }, data: { nspidBarcode: true } });
    }
    const job = await enqueue(prisma, ctx.shop.id, "barcode_sync", { variantIds: ids, flavorcloud }, ctx.actor, ids.length);
    return { jobId: job.id };
  }
  return { error: "Unknown action" };
};

const fmt = (n: number) => n.toLocaleString("en-US");

const CONFIDENCE: Record<Provider["confidence"], { tone: "success" | "info" | "warning"; label: string }> = {
  confirmed: { tone: "success", label: "From their docs" },
  partly: { tone: "info", label: "Partly published" },
  not_published: { tone: "warning", label: "Not published yet" },
};

export default function Ship() {
  const d = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();
  const saver = useFetcher();
  const runner = useFetcher<{ jobId?: string; error?: string }>();
  const jobId = runner.data?.jobId ?? d.runningJob;
  const scope = d.euOn ? "eu" : "all";
  // Optimistic: show the ticked boxes while the save is in flight.
  const pending = saver.formData?.get("providers");
  const selected = new Set(pending != null ? String(pending).split(",").filter(Boolean) : d.selected);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    saver.submit({ intent: "providers", providers: [...next].join(",") }, { method: "post" });
  };

  const runAction = (a: ProviderAction) => {
    if (a.kind === "file") downloadFile(`/app/ship/file?format=${a.format}&scope=${scope}`, `eu-customs-${a.format}.csv`);
  };

  const publishBox = (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-200">
        <s-text type="strong">Manufacturer codes in Shopify’s NS-PID barcode</s-text>
        <s-text color="subdued">
          {fmt(d.status.inBarcodes)} of {fmt(d.status.withNspid)} items with a manufacturer code have it as an NS-PID barcode.
          {d.syncCount ? ` ${fmt(d.syncCount)} still to write.` : ""} From now on, every code you save in PID Ready is written there too.
        </s-text>
        {d.syncWithoutBarcode > 0 && (
          <s-text color="subdued">
            {fmt(d.syncWithoutBarcode)} of them have no standard barcode, so the NS-PID barcode becomes their first barcode. Google Shopping reads the first barcode and may warn about these.
          </s-text>
        )}
        {runner.data?.error && <s-text tone="critical">{runner.data.error}</s-text>}
        {jobId ? (
          <JobProgress jobId={jobId} onDone={() => revalidate()} />
        ) : (
          <div>
            <s-button variant="primary" disabled={d.syncCount === 0 || undefined} onClick={() => runner.submit({ intent: "publish" }, { method: "post" })}>
              {d.syncCount ? `Write ${fmt(d.syncCount)} codes to Shopify` : "All written"}
            </s-button>
          </div>
        )}
      </s-stack>
    </s-box>
  );

  const chosen = PROVIDERS.filter((p) => selected.has(p.id));
  const needsPublish = chosen.some((p) => p.actions.some((a) => a.kind === "publish"));

  return (
    <s-page heading="Send codes to your shipping providers">
      <s-stack gap="base">
        <s-section>
          <s-stack gap="small-200">
            <s-paragraph>
              Customs gets the codes from whoever files your parcels, inside the electronic customs data. Nothing goes on the label.
              Tick every provider you use below. Each one shows exactly how it picks up the codes and what to do.
            </s-paragraph>
            <s-text color="subdued">
              {fmt(d.status.ready)} of {fmt(d.status.inScope)} items have all 3 codes. Fix the rest first, or the provider gets incomplete data.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="1. Which providers do you use?">
          <s-stack gap="base">
            {GROUPS.map((g) => (
              <s-stack key={g.id} gap="small-200">
                <s-text type="strong">{g.title}</s-text>
                <s-text color="subdued">{g.help}</s-text>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "4px 16px", marginTop: 4 }}>
                  {PROVIDERS.filter((p) => p.group === g.id).map((p) => (
                    <label key={p.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", padding: "4px 0" }}>
                      <input type="checkbox" checked={selected.has(p.id)} onChange={(e) => toggle(p.id, e.currentTarget.checked)} style={{ marginTop: 3 }} />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>
              </s-stack>
            ))}
            {saver.state !== "idle" && <s-text color="subdued">Saving…</s-text>}
          </s-stack>
        </s-section>

        {chosen.length === 0 && (
          <s-section>
            <s-paragraph>Tick at least one provider to see its steps. Not sure? Ask whoever prints your EU shipping labels.</s-paragraph>
          </s-section>
        )}

        {needsPublish && <s-section heading="2. Write the codes into Shopify">{publishBox}</s-section>}

        {chosen.map((p) => (
          <s-section key={p.id}>
            <s-stack gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-heading>{p.name}</s-heading>
                <s-badge tone={CONFIDENCE[p.confidence].tone}>{CONFIDENCE[p.confidence].label}</s-badge>
                {p.deadline && <s-badge tone="critical">{p.deadline}</s-badge>}
              </s-stack>
              <s-text color="subdued">{p.how}</s-text>
              <s-ordered-list>
                {p.steps.map((st) => (
                  <s-list-item key={st}>{st}</s-list-item>
                ))}
              </s-ordered-list>
              <s-stack direction="inline" gap="small">
                {p.actions.map((a, i) => {
                  if (a.kind === "publish") return null; // shown once, above
                  if (a.kind === "flavorcloud")
                    return (
                      <s-button key={i} variant="primary" disabled={(!!jobId) || undefined} onClick={() => runner.submit({ intent: "flavorcloud" }, { method: "post" })}>
                        Write FlavorCloud fields
                      </s-button>
                    );
                  if (a.kind === "print")
                    return (
                      <s-button key={i} href={`/app/ship/print?scope=${scope}${a.fedex ? "&fedex=1" : ""}`}>
                        {a.label}
                      </s-button>
                    );
                  return (
                    <s-button key={i} onClick={() => runAction(a)}>
                      {a.label}
                    </s-button>
                  );
                })}
              </s-stack>
              {p.source && (
                <s-text color="subdued">
                  Source: <s-link href={p.source} target="_blank">{new URL(p.source).hostname.replace(/^www\./, "")}</s-link>
                </s-text>
              )}
            </s-stack>
          </s-section>
        ))}

        <s-section heading="All files">
          <s-stack gap="small-200">
            <s-text color="subdued">
              Every file has one row per item{d.euOn ? " that can ship to the EU" : ""}. Codes come from your latest check.
            </s-text>
            <s-stack direction="inline" gap="small">
              <s-button variant="tertiary" onClick={() => runAction({ kind: "file", format: "standard", label: "" })}>Customs file</s-button>
              <s-button variant="tertiary" onClick={() => runAction({ kind: "file", format: "shipping_app", label: "" })}>Codes by SKU (m_pid, ns_pid, s_pid)</s-button>
              <s-button variant="tertiary" onClick={() => runAction({ kind: "file", format: "zonos", label: "" })}>Zonos Catalog</s-button>
              <s-button variant="tertiary" onClick={() => runAction({ kind: "file", format: "veeqo", label: "" })}>Veeqo</s-button>
              <s-button variant="tertiary" onClick={() => runAction({ kind: "file", format: "ups", label: "" })}>UPS</s-button>
              <s-button variant="tertiary" href={`/app/ship/print?scope=${scope}&fedex=1`}>Print list</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
