// UC-10 settings; UC-11 map to an existing metafield (E-09).
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { detectCandidates, NSPID_DEFAULT, type Candidate } from "../lib/metafields.server";
import { reevaluateShop } from "../lib/evaluate.server";
import { startScan } from "../lib/scan.server";
import { METAFIELD_DEFINITION_CREATE, METAFIELD_DEFINITIONS } from "../lib/queries";
import { DEFAULT_PLACEHOLDERS } from "@pidready/rules";
import { Checkbox, Mono, Switch, TextField } from "../components/wc";
import { toast } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, gql } = await adminContext(request);
  const vendors = await prisma.variantSnapshot.findMany({ where: { shopId: shop.id }, distinct: ["vendor"], select: { vendor: true }, orderBy: { vendor: "asc" } });
  let candidates: Candidate[] = [];
  try {
    candidates = await detectCandidates(gql);
  } catch {
    candidates = [];
  }
  const s = shop.settings;
  return {
    settings: {
      includeDraft: s.includeDraft,
      nspidKey: `${s.nspidNamespace}.${s.nspidKey}`,
      ownBrandVendors: s.ownBrandVendors,
      extraPlaceholders: s.extraPlaceholders.join("\n"),
      hsAsError: s.hsAsError,
      weeklyEmail: s.weeklyEmail,
      mappingRequired: s.mappingRequired,
    },
    vendors: vendors.map((v) => v.vendor).filter(Boolean),
    candidates,
    defaultKey: `${NSPID_DEFAULT.namespace}.${NSPID_DEFAULT.key}`,
    builtIn: [...DEFAULT_PLACEHOLDERS],
  };
};

type Body = {
  includeDraft: boolean;
  nspidKey: string;
  ownBrandVendors: string[];
  extraPlaceholders: string;
  hsAsError: boolean;
  weeklyEmail: boolean;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, gql, actor } = await adminContext(request);
  const b = (await request.json()) as Body;
  const m = /^([a-zA-Z0-9_-]{2,64})\.([a-zA-Z0-9_-]{2,64})$/.exec(b.nspidKey.trim());
  if (!m) return { error: "The manufacturer code field must look like namespace.key, for example customs.manufacturer_product_id." };
  const [, namespace, key] = m as unknown as [string, string, string];
  const s = shop.settings;
  const keyChanged = namespace !== s.nspidNamespace || key !== s.nspidKey;

  let mappingRequired = s.mappingRequired;
  if (keyChanged) {
    // UC-11: read and write the chosen key. Nothing is copied or deleted.
    const defs = (await gql<any>(METAFIELD_DEFINITIONS)).metafieldDefinitions.nodes as { namespace: string; key: string; type: { name: string } }[];
    const def = defs.find((d) => d.namespace === namespace && d.key === key);
    if (def && !["single_line_text_field", "multi_line_text_field"].includes(def.type.name)) {
      return { error: `${namespace}.${key} is a ${def.type.name} field. Pick a text field.` };
    }
    if (!def) {
      await gql(METAFIELD_DEFINITION_CREATE, {
        definition: { name: "Manufacturer product ID (NS-PID)", namespace, key, type: "single_line_text_field", ownerType: "PRODUCTVARIANT" },
      });
    }
    mappingRequired = false;
  }

  await prisma.settings.update({
    where: { shopId: shop.id },
    data: {
      includeDraft: b.includeDraft,
      nspidNamespace: namespace,
      nspidKey: key,
      ownBrandVendors: b.ownBrandVendors,
      extraPlaceholders: b.extraPlaceholders.split(/[\n,]/).map((x) => x.trim()).filter(Boolean).slice(0, 100),
      hsAsError: b.hsAsError,
      weeklyEmail: b.weeklyEmail,
      mappingRequired,
    },
  });
  await prisma.auditLog.create({ data: { shopId: shop.id, actor, action: "settings_update", newValue: JSON.stringify({ ...b, nspidKey: `${namespace}.${key}` }) } });

  if (keyChanged) {
    await startScan(prisma, gql, shop.id); // the new key must be read from Shopify
    return { ok: true, rescan: true };
  }
  await reevaluateShop(prisma, shop.id, { source: "settings" }); // AT-11: no Shopify call
  return { ok: true };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; error?: string; rescan?: boolean }>();
  const [f, setF] = useState(data.settings);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const keyOptions = [
    { key: data.defaultKey, label: "PID Ready default", samples: [] as string[] },
    ...data.candidates.map((c) => ({ key: `${c.namespace}.${c.key}`, label: c.definitionName ?? "Existing field", samples: c.samples })),
  ];
  const custom = !keyOptions.some((o) => o.key === f.nspidKey);

  const save = () => {
    fetcher.submit(
      {
        includeDraft: f.includeDraft,
        nspidKey: f.nspidKey,
        ownBrandVendors: f.ownBrandVendors,
        extraPlaceholders: f.extraPlaceholders,
        hsAsError: f.hsAsError,
        weeklyEmail: f.weeklyEmail,
      },
      { method: "post", encType: "application/json" },
    );
  };
  useEffect(() => {
    if (fetcher.data?.ok) toast(fetcher.data.rescan ? "Saved. Rescanning with the new field." : "Saved. Issues updated.");
  }, [fetcher.data]);

  return (
    <s-page heading="Settings">
      <s-button slot="primary-action" variant="primary" onClick={save} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
        Save
      </s-button>
      <s-stack gap="base">
        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
        {data.settings.mappingRequired && (
          <s-banner tone="warning" heading="Pick a field for manufacturer codes">
            <s-paragraph>
              Your store already has <Mono>{data.defaultKey}</Mono> with a different type, so we won’t touch it. Choose another field below.
            </s-paragraph>
          </s-banner>
        )}

        <s-section heading="Where manufacturer codes are stored">
          <s-paragraph>
            Shopify has no built-in field for the manufacturer’s code. We keep it in a product variant metafield your carrier can read. If you already store it somewhere, pick that field.
          </s-paragraph>
          <s-stack gap="small">
            {keyOptions.map((o) => (
              <label key={o.key} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", cursor: "pointer" }}>
                <input type="radio" name="nspidKey" checked={f.nspidKey === o.key} onChange={() => set("nspidKey", o.key)} style={{ marginTop: 4 }} />
                <span>
                  <Mono>{o.key}</Mono> <s-text color="subdued">{o.label}</s-text>
                  {o.samples.length > 0 && (
                    <>
                      <br />
                      <s-text color="subdued">Examples: {o.samples.join(", ")}</s-text>
                    </>
                  )}
                </span>
              </label>
            ))}
            <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input type="radio" name="nspidKey" checked={custom} onChange={() => set("nspidKey", "")} />
              <span>Another field (your carrier may ask for a specific one)</span>
            </label>
            {custom && <TextField label="namespace.key" value={f.nspidKey} onValue={(v) => set("nspidKey", v)} placeholder="e.g. global.mpn" />}
          </s-stack>
        </s-section>

        <s-section heading="What we check">
          <s-stack gap="base">
            <Switch label="Include draft products" checked={f.includeDraft} onChecked={(v) => set("includeDraft", v)} details="Off by default. Archived products are never checked." />
            <Switch
              label="Treat missing HS code and origin as errors"
              checked={f.hsAsError}
              onChecked={(v) => set("hsAsError", v)}
              details="They are warnings by default. Customs uses them for the €3 duty per product type."
            />
          </s-stack>
        </s-section>

        <s-section heading="Own-brand vendors">
          <s-paragraph>If you make the product yourself, your SKU can be the manufacturer code. Pick those vendors.</s-paragraph>
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="small">
            {data.vendors.map((v) => (
              <Checkbox
                key={v}
                label={v}
                checked={f.ownBrandVendors.includes(v)}
                onChecked={(on) => set("ownBrandVendors", on ? [...f.ownBrandVendors, v] : f.ownBrandVendors.filter((x) => x !== v))}
              />
            ))}
          </s-grid>
        </s-section>

        <s-section heading="Placeholder values">
          <s-paragraph>These count as missing: {data.builtIn.join(", ")}. Add your own, one per line.</s-paragraph>
          <s-text-area label="Extra placeholders" value={f.extraPlaceholders} rows={4} ref={(el: any) => {
            if (!el || el.__pid) return;
            el.__pid = true;
            el.addEventListener("input", () => set("extraPlaceholders", el.value));
          }} />
        </s-section>

        <s-section heading="Email">
          <Switch label="Weekly readiness email" checked={f.weeklyEmail} onChecked={(v) => set("weeklyEmail", v)} details="Coming soon on Growth and Scale plans." />
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
