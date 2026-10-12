// UC-04: fix one variant. Validation runs on every keystroke with the same rule engine.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { evaluate, normalizeBarcode } from "@pidready/rules";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import { applyChanges, type WriteOutcome } from "../lib/writes.server";
import { checkFixGate, upgradeResponse } from "../lib/gate.server";
import { fieldErrors, normalizeChange, type VariantChange } from "../lib/validate";
import { RULE_LABEL, SEVERITY_TONE, toast, When } from "../components/ui";
import { Checkbox, Mono, TextField } from "../components/wc";
import { UpgradePrompt, type Upgrade } from "../components/UpgradePrompt";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const variantId = decodeURIComponent(params.id!);
  const snap = await prisma.variantSnapshot.findUnique({ where: { shopId_variantId: { shopId: shop.id, variantId } } });
  if (!snap) throw new Response("Variant not found", { status: 404 });
  const issues = await prisma.issue.findMany({ where: { shopId: shop.id, variantId, status: "open" }, select: { ruleCode: true, severity: true, message: true, suggestion: true } });
  return {
    snap: { ...snap, updatedAt: snap.updatedAt.toISOString() },
    issues,
    settings: {
      extraPlaceholders: shop.settings.extraPlaceholders,
      ownBrandVendors: shop.settings.ownBrandVendors,
      hsAsError: shop.settings.hsAsError,
      includeDraft: shop.settings.includeDraft,
      mappingRequired: shop.settings.mappingRequired,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await adminContext(request);
  const variantId = decodeURIComponent(params.id!);
  const body = await request.json();
  const plan = await syncPlan(ctx);
  const gate = await checkFixGate(ctx.shop.id, plan, [variantId]);
  if (!gate.ok) return upgradeResponse(gate, `/app/variants/${encodeURIComponent(variantId)}?resume=1`);
  const [outcome] = await applyChanges(prisma, ctx.gql, { shopId: ctx.shop.id, actor: ctx.actor }, [
    { variantId, changes: body.changes as VariantChange, expectedUpdatedAt: body.expectedUpdatedAt },
  ]);
  return { outcome };
};

type Form = { sku: string; barcode: string; nspid: string; noStandardIdentifier: boolean; hsCode: string; countryOfOrigin: string };
const DRAFT_KEY = (id: string) => `pid-draft:${id}`;

export default function VariantPanel() {
  const { snap, issues, settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ outcome?: WriteOutcome; upgrade?: Upgrade }>();
  const { revalidate } = useRevalidator();
  const [params, setParams] = useSearchParams();

  const initial: Form = useMemo(
    () => ({
      sku: snap.sku ?? "",
      barcode: snap.barcodes[0] ?? "",
      nspid: snap.nspid ?? "",
      noStandardIdentifier: snap.noStandardIdentifier,
      hsCode: snap.hsCode ?? "",
      countryOfOrigin: snap.countryOfOrigin ?? "",
    }),
    [snap],
  );
  const [form, setForm] = useState<Form>(initial);
  useEffect(() => setForm(initial), [initial]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const changes: VariantChange = {};
  for (const k of Object.keys(form) as (keyof Form)[]) if (form[k] !== initial[k]) (changes as any)[k] = form[k];
  const dirty = Object.keys(changes).length > 0;

  // Live validation (same engine as the scan; cross-variant rules come from the last evaluation).
  const errs = fieldErrors(normalizeChange(changes), settings.extraPlaceholders);
  const live = useMemo(() => {
    const r = evaluate(
      [
        {
          id: snap.variantId,
          productId: snap.productId,
          vendor: snap.vendor,
          status: snap.status as any,
          requiresShipping: snap.requiresShipping,
          isGiftCard: snap.isGiftCard,
          sku: form.sku || null,
          barcodes: form.barcode ? [form.barcode, ...snap.barcodes.slice(1)] : snap.barcodes.slice(1),
          nspid: form.nspid || null,
          noStandardIdentifier: form.noStandardIdentifier,
          hsCode: form.hsCode || null,
          countryOfOrigin: form.countryOfOrigin || null,
        },
      ],
      settings,
    );
    const cross = issues.filter((i) => ["R-MPID-02", "R-SPID-06"].includes(i.ruleCode) && !dirty);
    return [...r.issues.map((i) => ({ ruleCode: i.code, severity: i.severity, message: i.message, suggestion: i.suggestion ?? null })), ...cross];
  }, [form, snap, settings, issues, dirty]);

  const save = () => {
    try {
      sessionStorage.setItem(DRAFT_KEY(snap.variantId), JSON.stringify(form));
    } catch {
      /* storage may be blocked */
    }
    fetcher.submit({ changes, expectedUpdatedAt: snap.updatedAt } as any, { method: "post", encType: "application/json" });
  };

  // UC-15: after plan approval, restore the draft and finish the save (once).
  const resumed = useRef(false);
  useEffect(() => {
    if (params.get("resume") !== "1" || resumed.current) return;
    resumed.current = true;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY(snap.variantId));
      if (raw) {
        const d = JSON.parse(raw) as Form;
        setForm(d);
        const ch: VariantChange = {};
        for (const k of Object.keys(d) as (keyof Form)[]) if (d[k] !== initial[k]) (ch as any)[k] = d[k];
        if (Object.keys(ch).length) fetcher.submit({ changes: ch, expectedUpdatedAt: snap.updatedAt } as any, { method: "post", encType: "application/json" });
      }
    } catch {
      /* ignore */
    }
    const next = new URLSearchParams(params);
    next.delete("resume");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outcome = fetcher.data?.outcome;
  useEffect(() => {
    if (outcome?.status === "saved" && !Object.keys(outcome.errors).length) {
      toast("Saved");
      try {
        sessionStorage.removeItem(DRAFT_KEY(snap.variantId));
      } catch {
        /* ignore */
      }
      revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const serverErr = (outcome?.errors ?? {}) as Record<string, string>;
  const suggestion = live.find((i) => i.ruleCode === "R-SPID-02" && i.suggestion)?.suggestion;
  const saving = fetcher.state !== "idle";
  const title = [snap.productTitle, snap.variantTitle].filter(Boolean).join(" · ");

  return (
    <s-page heading={title}>
      <s-link slot="breadcrumb-actions" href="/app/issues">Issues</s-link>
      <s-button slot="primary-action" variant="primary" onClick={save} {...(!dirty || saving ? { disabled: true } : {})} {...(saving ? { loading: true } : {})}>
        Save
      </s-button>
      <s-button slot="secondary-actions" onClick={() => setForm(initial)} {...(!dirty ? { disabled: true } : {})}>
        Discard
      </s-button>

      <s-stack gap="base">
        {settings.mappingRequired && (
          <s-banner tone="warning" heading="Choose where manufacturer codes live first">
            <s-button href="/app/settings">Open Settings</s-button>
          </s-banner>
        )}
        {fetcher.data?.upgrade && <UpgradePrompt upgrade={fetcher.data.upgrade} />}
        {outcome?.status === "conflict" && (
          <s-banner tone="warning" heading="This product changed. Reload?">
            <s-paragraph>Someone edited it in Shopify after you opened it. Nothing was overwritten.</s-paragraph>
            <s-button onClick={() => { revalidate(); }}>Reload</s-button>
          </s-banner>
        )}
        {outcome?.status === "missing" && <s-banner tone="critical" heading="This variant no longer exists in Shopify." />}
        {serverErr.general && outcome?.status !== "conflict" && <s-banner tone="critical">{serverErr.general}</s-banner>}
        {outcome?.status === "saved" && Object.keys(outcome.errors).length > 0 && (
          <s-banner tone="warning" heading="Some fields didn’t save">
            <s-paragraph>Your other changes were saved. Check the fields marked below.</s-paragraph>
          </s-banner>
        )}

        <s-query-container><s-grid gridTemplateColumns="@container (inline-size > 760px) 3fr 2fr, 1fr" gap="base">
          <s-section heading="Customs identifiers">
            <s-stack gap="base">
              <TextField label="SKU (your product code)" value={form.sku} onValue={(v) => set("sku", v)} error={errs.sku ?? serverErr.sku} details="Customs uses this as the M-PID." />
              <TextField
                label="Manufacturer code"
                value={form.nspid}
                onValue={(v) => set("nspid", v)}
                error={errs.nspid ?? serverErr.nspid}
                details="The maker’s own model or part number (NS-PID). Ask your supplier if you don’t have it."
              />
              <TextField
                label="Barcode (GTIN, EAN, UPC or ISBN-13)"
                value={form.barcode}
                onValue={(v) => set("barcode", v)}
                error={form.noStandardIdentifier && form.barcode ? null : (errs.barcode ?? serverErr.barcode)}
                details={form.barcode && normalizeBarcode(form.barcode) !== form.barcode ? `Will be saved as ${normalizeBarcode(form.barcode)}` : undefined}
              />
              {suggestion && (
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text>Did you mean <Mono>{suggestion}</Mono>?</s-text>
                  <s-button variant="tertiary" onClick={() => set("barcode", suggestion)}>Use this</s-button>
                </s-stack>
              )}
              {snap.barcodes.length > 1 && (
                <s-text color="subdued">Other stored barcodes (read-only): {snap.barcodes.slice(1).join(", ")}</s-text>
              )}
              <Checkbox
                label="This item has no standard barcode"
                checked={form.noStandardIdentifier}
                onChecked={(v) => set("noStandardIdentifier", v)}
                details="Only tick this if no GTIN, EAN, UPC or ISBN exists. Customs gets exception code Y081."
              />
              <s-divider />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <TextField label="HS code" value={form.hsCode} onValue={(v) => set("hsCode", v)} error={errs.hsCode ?? serverErr.hsCode} details="6–10 digits" />
                <TextField label="Country of origin" value={form.countryOfOrigin} onValue={(v) => set("countryOfOrigin", v.toUpperCase())} error={errs.countryOfOrigin ?? serverErr.countryOfOrigin} details="Two letters, e.g. IN" />
              </s-grid>
            </s-stack>
          </s-section>

          <s-section heading={dirty ? "Check after your changes" : "Current issues"}>
            {live.length === 0 ? (
              <s-banner tone="success" heading="Ready for EU customs" />
            ) : (
              <s-stack gap="small">
                {live.map((i) => (
                  <s-stack key={i.ruleCode} direction="inline" gap="small" alignItems="start">
                    <s-badge tone={SEVERITY_TONE[i.severity as keyof typeof SEVERITY_TONE]}>{i.severity}</s-badge>
                    <s-stack gap="none">
                      <s-text type="strong">{RULE_LABEL[i.ruleCode] ?? i.ruleCode}</s-text>
                      <s-text>{i.message}</s-text>
                    </s-stack>
                  </s-stack>
                ))}
              </s-stack>
            )}
            <s-divider />
            <s-stack gap="small-200">
              <s-text color="subdued">Vendor: {snap.vendor || "—"}</s-text>
              <s-text color="subdued">Last changed in Shopify: <When iso={snap.updatedAt} /></s-text>
            </s-stack>
          </s-section>
        </s-grid></s-query-container>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
