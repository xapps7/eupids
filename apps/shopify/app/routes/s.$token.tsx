// UC-08: public supplier page. No login; the token is the key. Shows only title, variant,
// image and the store's SKU (NFR Supplier page). WCAG 2.1 AA: labelled inputs, visible focus,
// 4.5:1 contrast, errors announced.
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { isValidGtin, normalizeBarcode } from "@pidready/rules";
import prisma from "../db.server";
import { parseSupplierCsv, publicItems, requestByToken, submit, supplierCsv, type SupplierRow } from "../lib/supplier.server";

export const meta: MetaFunction = () => [{ title: "Product codes request" }, { name: "robots", content: "noindex, nofollow" }];

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const req = await requestByToken(prisma, params.token!);
  if (!req) return { expired: true as const };
  if (new URL(request.url).searchParams.get("download") === "csv") {
    return new Response("﻿" + (await supplierCsv(prisma, req)), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="product-codes.csv"`, "Cache-Control": "no-store" },
    }) as any;
  }
  const items = await publicItems(prisma, req);
  return {
    expired: false as const,
    store: req.shop.name ?? req.shop.domain.replace(".myshopify.com", ""),
    supplierName: req.supplierName,
    expiresAt: req.expiresAt.toISOString(),
    // variantId is deliberately dropped here.
    items: items.map(({ variantId: _v, ...rest }) => rest),
  };
};

type Result = { ok: boolean; saved?: number; errors?: { ref: number; error: string }[]; error?: string };

export const action = async ({ params, request }: ActionFunctionArgs): Promise<Result> => {
  const req = await requestByToken(prisma, params.token!);
  if (!req) return { ok: false, error: "This link has expired." };
  const body = (await request.json()) as { rows?: SupplierRow[]; csv?: string };
  let rows: SupplierRow[] = [];
  try {
    rows = body.csv ? parseSupplierCsv(body.csv) : (body.rows ?? []);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  rows = rows.slice(0, 5000).map((r) => ({ ref: Number(r.ref), nspid: String(r.nspid ?? "").slice(0, 200), barcode: String(r.barcode ?? "").slice(0, 40), noBarcode: !!r.noBarcode }));
  return submit(prisma, req, rows);
};

type Row = { nspid: string; barcode: string; noBarcode: boolean };

function barcodeState(v: string, none: boolean): "empty" | "ok" | "bad" | "none" {
  const b = normalizeBarcode(v);
  if (!b) return none ? "none" : "empty";
  return isValidGtin(b) ? "ok" : "bad";
}

const css = `
body{margin:0}
.sp{--ink:#1a1f24;--muted:#56606b;--line:#d3d8de;--bg:#f4f6f8;--card:#fff;--accent:#1d4ed8;--bad:#b42318;--ok:#1a7f4b;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);min-height:100vh}
.sp *{box-sizing:border-box}
.sp .wrap{max-width:1040px;margin:0 auto;padding:28px 16px 48px}
.sp h1{font-size:26px;line-height:1.2;margin:0 0 6px;text-wrap:balance}
.sp p{margin:0 0 10px;color:var(--muted);max-width:68ch}
.sp .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:18px}
.sp table{width:100%;border-collapse:collapse}
.sp th{text-align:left;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:8px;border-bottom:1px solid var(--line)}
.sp td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.sp .item{display:flex;gap:10px;align-items:center}
.sp .item img{width:44px;height:44px;object-fit:cover;border-radius:6px;background:var(--bg)}
.sp .sku{font:12.5px ui-monospace,Menlo,monospace;color:var(--muted)}
.sp input[type=text]{width:100%;font:inherit;padding:8px 10px;border:1px solid #8a939d;border-radius:6px;background:#fff;color:var(--ink)}
.sp input[aria-invalid=true]{border-color:var(--bad)}
.sp input:focus-visible,.sp button:focus-visible,.sp a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.sp .hint{font-size:12.5px;margin-top:4px}
.sp .hint.bad{color:var(--bad)} .sp .hint.ok{color:var(--ok)}
.sp .btn{display:inline-flex;align-items:center;gap:8px;font:600 15px system-ui;padding:11px 18px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.sp .btn.secondary{background:#fff;color:var(--accent)}
.sp .actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
.sp .banner{padding:12px 14px;border-radius:8px;margin-top:14px}
.sp .banner.ok{background:#e6f4ec;color:#0f5132} .sp .banner.bad{background:#fdecea;color:#7a1a12}
.sp .locked{font-size:13px;color:var(--ok)}
.sp .foot{margin-top:28px;font-size:13px;color:var(--muted)}
.sp .tw{overflow-x:auto}
@media (max-width:720px){.sp table,.sp thead,.sp tbody,.sp tr,.sp td{display:block}.sp thead{display:none}.sp tr{border-bottom:1px solid var(--line);padding:8px 0}.sp td{border:0;padding:6px 0}}
`;

export default function SupplierPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<Result>();
  const initial = useMemo(() => {
    const m: Record<number, Row> = {};
    if (!data.expired) for (const i of data.items as any[]) m[i.ref] = { nspid: i.submitted?.nspid ?? "", barcode: i.submitted?.barcode ?? "", noBarcode: i.submitted?.noBarcode ?? false };
    return m;
  }, [data]);
  const [rows, setRows] = useState<Record<number, Row>>(initial);

  if (data.expired) {
    return (
      <div className="sp">
        <style>{css}</style>
        <main className="wrap">
          <h1>This link has expired</h1>
          <p>Ask the store that sent it for a new link.</p>
        </main>
      </div>
    );
  }

  const set = (ref: number, patch: Partial<Row>) => setRows((r) => ({ ...r, [ref]: { ...r[ref]!, ...patch } }));
  const filled = Object.values(rows).filter((r) => r.nspid.trim() || r.barcode.trim() || r.noBarcode).length;
  const invalid = Object.values(rows).filter((r) => barcodeState(r.barcode, r.noBarcode) === "bad").length;
  const res = fetcher.data;
  const serverErr = new Map((res?.errors ?? []).map((e) => [e.ref, e.error]));

  const send = () =>
    fetcher.submit({ rows: (data.items as any[]).map((i) => ({ ref: i.ref, ...rows[i.ref]! })) } as any, { method: "post", encType: "application/json" });

  const upload = async (file?: File) => {
    if (!file) return;
    fetcher.submit({ csv: await file.text() } as any, { method: "post", encType: "application/json" });
  };

  return (
    <div className="sp">
      <style>{css}</style>
      <main className="wrap">
        <h1>{data.store} needs product codes</h1>
        <p>
          Hi {data.supplierName}. From 1 November 2026, EU customs needs the manufacturer’s own product code for items shipped to EU shoppers. Please add the code you use for each item, and its barcode if it has one.
        </p>
        <p>You can save part of the list and come back. This link works until {new Date(data.expiresAt).toLocaleDateString()}.</p>

        <div className="actions">
          <a className="btn secondary" href="?download=csv">Download list as CSV</a>
          <label className="btn secondary" style={{ cursor: "pointer" }}>
            Upload filled CSV
            <input type="file" accept=".csv,text/csv" style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} onChange={(e) => upload(e.currentTarget.files?.[0])} />
          </label>
        </div>

        <div role="status" aria-live="polite">
          {res?.ok && (
            <div className="banner ok">
              Sent to {data.store}. {res.saved} item{res.saved === 1 ? "" : "s"} saved. You can come back to edit until they approve.
              {res.errors?.length ? ` ${res.errors.length} item(s) need a fix; see below.` : ""}
            </div>
          )}
          {res && !res.ok && <div className="banner bad">{res.error}</div>}
        </div>

        <div className="card tw">
          <table>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Your manufacturer code</th>
                <th scope="col">Barcode (GTIN / EAN / UPC)</th>
                <th scope="col">No barcode</th>
              </tr>
            </thead>
            <tbody>
              {(data.items as any[]).map((i) => {
                const r = rows[i.ref]!;
                const st = barcodeState(r.barcode, r.noBarcode);
                const err = serverErr.get(i.ref);
                const locked = i.submitted?.locked;
                return (
                  <tr key={i.ref}>
                    <td>
                      <div className="item">
                        {i.imageUrl ? <img src={i.imageUrl} alt="" /> : null}
                        <div>
                          <div>{i.productTitle}</div>
                          {i.variantTitle ? <div style={{ color: "var(--muted)", fontSize: 13 }}>{i.variantTitle}</div> : null}
                          <div className="sku">Store SKU {i.sku || "—"} · #{i.ref}</div>
                          {locked && <div className="locked">Approved by the store</div>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <label className="sr" htmlFor={`n-${i.ref}`} style={{ position: "absolute", left: -9999 }}>Manufacturer code for {i.productTitle}</label>
                      <input id={`n-${i.ref}`} type="text" value={r.nspid} maxLength={70} disabled={locked} onChange={(e) => set(i.ref, { nspid: e.target.value })} placeholder={i.needsNspid ? "Required" : "Optional"} />
                    </td>
                    <td>
                      <label htmlFor={`b-${i.ref}`} style={{ position: "absolute", left: -9999 }}>Barcode for {i.productTitle}</label>
                      <input
                        id={`b-${i.ref}`}
                        type="text"
                        inputMode="numeric"
                        value={r.barcode}
                        disabled={locked || r.noBarcode}
                        aria-invalid={st === "bad" || !!err}
                        aria-describedby={`bh-${i.ref}`}
                        onChange={(e) => set(i.ref, { barcode: e.target.value })}
                      />
                      <div id={`bh-${i.ref}`} className={`hint ${st === "bad" || err ? "bad" : st === "ok" ? "ok" : ""}`}>
                        {err ?? (st === "bad" ? "This barcode isn’t valid. Check the digits." : st === "ok" ? "Looks right" : "")}
                      </div>
                    </td>
                    <td>
                      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={r.noBarcode} disabled={locked} onChange={(e) => set(i.ref, { noBarcode: e.target.checked, ...(e.target.checked ? { barcode: "" } : {}) })} />
                        None exists
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <button className="btn" type="button" onClick={send} disabled={fetcher.state !== "idle"}>
            {fetcher.state !== "idle" ? "Sending…" : `Send ${filled} item${filled === 1 ? "" : "s"}`}
          </button>
          {invalid > 0 && <span style={{ color: "var(--bad)" }}>{invalid} barcode{invalid === 1 ? "" : "s"} to check</span>}
        </div>
        <p className="foot">Only the store that sent this link sees what you enter. Nothing changes in their shop until they review it.</p>
      </main>
    </div>
  );
}
