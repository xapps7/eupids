// Suppliers list (UC-07 entry point, UC-09 notification).
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { adminContext } from "../lib/context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await adminContext(request);
  const reqs = await prisma.supplierRequest.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } }, submissions: { select: { reviewStatus: true } } },
  });
  return {
    rows: reqs.map((r) => ({
      id: r.id,
      supplierName: r.supplierName,
      supplierEmail: r.supplierEmail,
      createdAt: r.createdAt.toISOString(),
      items: r._count.items,
      pending: r.submissions.filter((s) => s.reviewStatus === "pending").length,
      approved: r.submissions.filter((s) => s.reviewStatus === "approved").length,
      state: r.revoked ? "revoked" : r.expiresAt.getTime() < Date.now() ? "expired" : "active",
    })),
  };
};

export default function Suppliers() {
  const { rows } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Suppliers">
      <s-button slot="primary-action" variant="primary" href="/app/suppliers/new">New request</s-button>
      {rows.length === 0 ? (
        <s-section heading="No requests yet">
          <s-ordered-list>
            <s-list-item>Pick a vendor. We list its items missing manufacturer codes or barcodes.</s-list-item>
            <s-list-item>Send your supplier the link. They fill in codes; no login needed.</s-list-item>
            <s-list-item>Review what they sent and approve. Only then is anything saved to Shopify.</s-list-item>
          </s-ordered-list>
          <s-button href="/app/suppliers/new">Create a request</s-button>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Supplier</s-table-header>
              <s-table-header format="numeric">Items</s-table-header>
              <s-table-header format="numeric">To review</s-table-header>
              <s-table-header format="numeric">Approved</s-table-header>
              <s-table-header>Link</s-table-header>
              <s-table-header>Created</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={r.id}>
                  <s-table-cell>
                    <s-link href={`/app/suppliers/${r.id}`}>{r.supplierName}</s-link>
                  </s-table-cell>
                  <s-table-cell>{r.items}</s-table-cell>
                  <s-table-cell>{r.pending ? <s-badge tone="warning">{r.pending}</s-badge> : "0"}</s-table-cell>
                  <s-table-cell>{r.approved}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={r.state === "active" ? "success" : "neutral"}>{r.state}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{new Date(r.createdAt).toLocaleDateString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
