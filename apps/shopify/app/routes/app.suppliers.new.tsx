// UC-07: create a supplier request → token link, ready-to-copy message, item CSV.
import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext, syncPlan } from "../lib/context.server";
import * as supplier from "../lib/supplier.server";
import { checkSupplierGate, upgradeResponse } from "../lib/gate.server";
import { Select, TextField } from "../components/wc";
import { UpgradePrompt, type Upgrade } from "../components/UpgradePrompt";
import { downloadFile, toast } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const vendor = url.searchParams.get("vendor") ?? "";
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  const vendors = await prisma.variantSnapshot.findMany({ where: { shopId: shop.id, inScope: true }, distinct: ["vendor"], select: { vendor: true }, orderBy: { vendor: "asc" } });
  const items = ids.length ? await supplier.itemsFromIssues(prisma, shop.id, ids) : vendor ? await supplier.defaultItemsForVendor(prisma, shop.id, vendor) : [];
  const snaps = await prisma.variantSnapshot.findMany({
    where: { shopId: shop.id, variantId: { in: items.map((i) => i.variantId) } },
    select: { variantId: true, productTitle: true, variantTitle: true, sku: true },
  });
  const by = new Map(snaps.map((s) => [s.variantId, s]));
  return {
    vendor,
    ids,
    vendors: vendors.map((v) => v.vendor).filter(Boolean),
    items: items.map((i) => ({ ...i, ...by.get(i.variantId) })),
    storeName: shop.name ?? shop.domain,
  };
};

type Result = { error?: string; upgrade?: Upgrade; requestId?: string; link?: string; message?: string; count?: number };

export const action = async ({ request }: ActionFunctionArgs): Promise<Result> => {
  const ctx = await adminContext(request);
  const body = (await request.json()) as { supplierName: string; supplierEmail?: string; vendor?: string; ids?: string[] };
  if (!body.supplierName?.trim()) return { error: "Add the supplier’s name." };
  if (body.supplierEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.supplierEmail)) return { error: "That email address doesn’t look right." };
  const plan = await syncPlan(ctx);
  const gate = await checkSupplierGate(ctx.shop.id, plan);
  if (!gate.ok) return upgradeResponse(gate, "/app/suppliers/new" + (body.vendor ? `?vendor=${encodeURIComponent(body.vendor)}` : ""));
  const items = body.ids?.length
    ? await supplier.itemsFromIssues(prisma, ctx.shop.id, body.ids)
    : await supplier.defaultItemsForVendor(prisma, ctx.shop.id, body.vendor ?? "");
  if (!items.length) return { error: "No items need codes from this supplier." };
  const { request: req, token } = await supplier.createRequest(prisma, {
    shopId: ctx.shop.id,
    supplierName: body.supplierName,
    supplierEmail: body.supplierEmail,
    createdBy: ctx.actor,
    items,
  });
  const link = supplier.supplierLink(token);
  return {
    requestId: req.id,
    link,
    count: items.length,
    message: supplier.supplierMessage(ctx.shop.name ?? ctx.shop.domain, body.supplierName.trim(), link, items.length),
  };
};

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Select the text and copy it", true);
  }
}

export default function NewRequest() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<Result>();
  const navigate = useNavigate();
  const [name, setName] = useState(data.vendor);
  const [email, setEmail] = useState("");
  const [vendor, setVendor] = useState(data.vendor);
  const res = fetcher.data;

  if (res?.link) {
    return (
      <s-page heading={`Request for ${name}`}>
        <s-link slot="breadcrumb-actions" href="/app/suppliers">Suppliers</s-link>
        <s-stack gap="base">
          <s-banner tone="success" heading={`Link created for ${res.count} items`}>
            <s-paragraph>Copy the link now. For security we only show it once. You can create a new link later from the request page.</s-paragraph>
          </s-banner>
          <s-section heading="Supplier link">
            <s-stack gap="small">
              <code style={{ wordBreak: "break-all", fontSize: 13 }}>{res.link}</code>
              <s-stack direction="inline" gap="small">
                <s-button variant="primary" onClick={() => copy(res.link!)}>Copy link</s-button>
                <s-button onClick={() => downloadFile(`/app/suppliers/${res.requestId}/items`, "items.csv")}>Download item list (CSV)</s-button>
              </s-stack>
            </s-stack>
          </s-section>
          <s-section heading="Message to send">
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 14, margin: 0 }}>{res.message}</pre>
            <s-button onClick={() => copy(res.message!)}>Copy message</s-button>
          </s-section>
          <s-button href={`/app/suppliers/${res.requestId}`}>Go to request</s-button>
        </s-stack>
      </s-page>
    );
  }

  const byVendor = !data.ids.length;
  return (
    <s-page heading="New supplier request">
      <s-link slot="breadcrumb-actions" href="/app/suppliers">Suppliers</s-link>
      <s-stack gap="base">
        {res?.upgrade && <UpgradePrompt upgrade={res.upgrade} />}
        {res?.error && <s-banner tone="critical">{res.error}</s-banner>}
        <s-section>
          <s-stack gap="base">
            {byVendor && (
              <Select
                label="Vendor"
                value={vendor}
                onValue={(v) => {
                  setVendor(v);
                  if (!name || name === vendor) setName(v);
                  navigate(`?vendor=${encodeURIComponent(v)}`, { replace: true });
                }}
                options={[{ value: "", label: "Choose a vendor" }, ...data.vendors.map((v) => ({ value: v, label: v }))]}
              />
            )}
            <TextField label="Supplier name" value={name} onValue={setName} />
            <TextField label="Supplier email (optional)" value={email} onValue={setEmail} details="Kept so you remember who you asked. The app doesn’t email them yet; you send the message." />
          </s-stack>
        </s-section>
        <s-section heading={`Items in this request (${data.items.length})`}>
          {data.items.length === 0 ? (
            <s-paragraph>{byVendor && !vendor ? "Choose a vendor to see its items." : "Nothing here needs a manufacturer code or barcode."}</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Item</s-table-header>
                <s-table-header>Your SKU</s-table-header>
                <s-table-header>Needs</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {data.items.slice(0, 100).map((i) => (
                  <s-table-row key={i.variantId}>
                    <s-table-cell>{[i.productTitle, i.variantTitle].filter(Boolean).join(" / ")}</s-table-cell>
                    <s-table-cell>{i.sku || "—"}</s-table-cell>
                    <s-table-cell>{[i.needsNspid && "manufacturer code", i.needsBarcode && "barcode"].filter(Boolean).join(", ")}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
          {data.items.length > 100 && <s-text color="subdued">and {data.items.length - 100} more</s-text>}
        </s-section>
        <s-stack direction="inline">
          <s-button
            variant="primary"
            {...(!data.items.length || fetcher.state !== "idle" ? { disabled: true } : {})}
            {...(fetcher.state !== "idle" ? { loading: true } : {})}
            onClick={() => fetcher.submit({ supplierName: name, supplierEmail: email, vendor, ids: data.ids }, { method: "post", encType: "application/json" })}
          >
            Create link
          </s-button>
        </s-stack>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
