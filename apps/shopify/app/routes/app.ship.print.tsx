// A printable sheet of the customs codes: one EU order, or the whole list of items.
// Customs doesn't need paper. This is for people who type shipments into a carrier website
// by hand, or who attach the codes to a commercial invoice.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { orderSheet, productSheet, type CodeRow } from "../lib/ship.server";
import { euFilterOn } from "../lib/eu-orders.server";
import { DISCLAIMER } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order");
  if (orderId) {
    const sheet = await orderSheet(prisma, shop.id, orderId);
    if (!sheet) throw new Response("Order not found", { status: 404 });
    return { kind: "order" as const, store: shop.name ?? shop.domain, ...sheet };
  }
  const eu = euFilterOn(shop);
  const rows = await productSheet(prisma, shop.id, eu);
  return { kind: "list" as const, store: shop.name ?? shop.domain, eu, rows };
};

const css = `
.sheet{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff;padding:20px;max-width:1100px;margin:0 auto}
.sheet h1{font-size:20px;margin:0 0 4px}
.sheet .meta{color:#555;margin:0 0 14px}
.sheet table{width:100%;border-collapse:collapse}
.sheet th{text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#555;border-bottom:2px solid #1a1a1a;padding:6px 6px}
.sheet td{border-bottom:1px solid #ddd;padding:7px 6px;vertical-align:top}
.sheet td.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;white-space:nowrap}
.sheet .miss{color:#b42318;font-weight:600}
.sheet .sub{color:#666;font-size:12px}
.sheet .bar{display:flex;gap:10px;align-items:center;margin-bottom:16px}
.sheet .btn{font:600 14px system-ui;padding:9px 16px;border-radius:8px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}
.sheet .link{color:#005bd3;text-decoration:none;font-weight:500}
.sheet .foot{margin-top:16px;color:#666;font-size:11.5px}
@media print{.noprint{display:none!important}.sheet{padding:0;max-width:none}@page{margin:12mm}}
`;

function Codes({ r }: { r: CodeRow }) {
  const miss = <span className="miss">MISSING</span>;
  return (
    <>
      <td className="code">{r.sku || miss}</td>
      <td className="code">{r.nspid || miss}</td>
      <td className="code">{r.barcode === "Y081" ? <>Y081 <span className="sub">(no barcode)</span></> : r.barcode || miss}</td>
      <td className="code">{r.hsCode || "—"}</td>
      <td className="code">{r.origin || "—"}</td>
    </>
  );
}

export default function PrintSheet() {
  const d = useLoaderData<typeof loader>();
  const missing = d.rows.filter((r) => !r.sku || !r.nspid || !r.barcode).length;
  return (
    <div className="sheet">
      <style>{css}</style>
      <div className="bar noprint">
        <button className="btn" type="button" onClick={() => window.print()}>Print</button>
        <Link className="link" to="/app/ship">Back</Link>
        {missing > 0 && <span className="miss">{missing} item{missing === 1 ? "" : "s"} still missing a code. Fix them in Issues first if you can.</span>}
      </div>
      {d.kind === "order" ? (
        <>
          <h1>EU customs codes · Order {d.name}</h1>
          <p className="meta">
            {d.store} · {new Date(d.createdAt).toLocaleDateString()} · Ship to {d.country}
          </p>
        </>
      ) : (
        <>
          <h1>EU customs codes · {d.eu ? "Items shipped to the EU" : "All items"}</h1>
          <p className="meta">
            {d.store} · {d.rows.length} items · {new Date().toLocaleDateString()}
          </p>
        </>
      )}
      <table>
        <thead>
          <tr>
            <th>Item</th>
            {d.kind === "order" && <th>Qty</th>}
            {d.kind === "order" && <th>Unit value</th>}
            <th>SKU (M-PID)</th>
            <th>Manufacturer code (NS-PID)</th>
            <th>Barcode (S-PID)</th>
            <th>HS code</th>
            <th>Origin</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={(r.variantId ?? "") + i}>
              <td>
                {r.title}
                {r.variantTitle ? <div className="sub">{r.variantTitle}</div> : null}
              </td>
              {d.kind === "order" && <td>{r.quantity}</td>}
              {d.kind === "order" && <td className="code">{r.unitPrice ? `${r.unitPrice} ${r.currency ?? ""}` : "—"}</td>}
              <Codes r={r} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="foot">
        Customs document codes: M-PID = C127, NS-PID = C128, S-PID = C129, no barcode = Y081. {DISCLAIMER}
      </p>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
