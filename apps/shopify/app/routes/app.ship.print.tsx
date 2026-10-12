// A printable list of the customs codes, for people who type shipments into a carrier website
// or post-office form. With ?fedex=1 each item also shows its FedEx "Product Identifier" text.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";
import { productSheet } from "../lib/ship.server";
import { euVariantIds } from "../lib/eu-shipping.server";
import { DISCLAIMER, When } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const url = new URL(request.url);
  const only = url.searchParams.get("scope") === "eu" ? await euVariantIds(prisma, shop.id) : null;
  const rows = await productSheet(prisma, shop.id, only && only.size ? only : null);
  return { store: shop.name ?? shop.domain, eu: !!(only && only.size), fedex: url.searchParams.get("fedex") === "1", rows };
};

const css = `
.sheet{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#fff;padding:20px;max-width:1150px;margin:0 auto}
.sheet h1{font-size:20px;margin:0 0 4px}
.sheet .meta{color:#555;margin:0 0 14px}
.sheet table{width:100%;border-collapse:collapse}
.sheet th{text-align:left;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#555;border-bottom:2px solid #1a1a1a;padding:6px}
.sheet td{border-bottom:1px solid #ddd;padding:7px 6px;vertical-align:top}
.sheet td.code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;white-space:nowrap}
.sheet .fx{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#333;margin-top:3px;user-select:all}
.sheet .miss{color:#b42318;font-weight:600}
.sheet .sub{color:#666;font-size:12px}
.sheet .bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.sheet .btn{font:600 14px system-ui;padding:9px 16px;border-radius:8px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}
.sheet .link{color:#005bd3;text-decoration:none;font-weight:500}
.sheet .foot{margin-top:16px;color:#666;font-size:11.5px}
@media print{.noprint{display:none!important}.sheet{padding:0;max-width:none}@page{margin:12mm}tr{break-inside:avoid}}
`;

export default function PrintSheet() {
  const d = useLoaderData<typeof loader>();
  const missing = d.rows.filter((r) => !r.sku || !r.nspid || !r.barcode).length;
  const miss = <span className="miss">MISSING</span>;
  return (
    <div className="sheet">
      <style>{css}</style>
      <div className="bar noprint">
        <button className="btn" type="button" onClick={() => window.print()}>Print</button>
        <Link className="link" to="/app/ship">Back</Link>
        <Link className="link" to={`?${d.eu ? "scope=eu&" : ""}${d.fedex ? "" : "fedex=1"}`}>{d.fedex ? "Hide FedEx text" : "Show FedEx text"}</Link>
        {missing > 0 && <span className="miss">{missing} item{missing === 1 ? "" : "s"} still missing a code.</span>}
      </div>
      <h1>EU customs codes · {d.eu ? "Items that can ship to the EU" : "All items"}</h1>
      <p className="meta">
        {d.store} · {d.rows.length} items · <When iso={new Date().toISOString().slice(0, 10)} date />
      </p>
      <table>
        <thead>
          <tr>
            <th>Item</th>
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
                {d.fedex && r.fedex ? <div className="fx">{r.fedex}</div> : null}
              </td>
              <td className="code">{r.sku || miss}</td>
              <td className="code">{r.nspid || miss}</td>
              <td className="code">{r.barcode === "Y081" ? <>none <span className="sub">(Y081)</span></> : r.barcode || miss}</td>
              <td className="code">{r.hsCode || "—"}</td>
              <td className="code">{r.origin || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="foot">
        Customs codes: M-PID = C127, NS-PID = C128, S-PID = C129, no barcode = Y081. FedEx writes “S-PIDNO”, UPS “No” when there is no barcode. {DISCLAIMER}
      </p>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
