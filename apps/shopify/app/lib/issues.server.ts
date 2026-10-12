// UC-03 / FR-05: issues list — filters, search, cursor pagination with no row cap.
import { Prisma, type PrismaClient } from "@prisma/client";

export type IssueFilters = {
  code?: string | null; // one code, or several comma-separated
  severity?: string | null;
  vendor?: string | null;
  type?: string | null;
  status?: "open" | "resolved";
  q?: string | null;
  cursor?: string | null;
  /** EU focus: only variants whose shipping profile reaches the EU. Value = does the default profile? */
  euDefault?: boolean | null;
};

export const PAGE_SIZE = 50;

type Cursor = [string, string]; // [productTitle, variantId]
const enc = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
const dec = (s: string | null | undefined): Cursor | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return Array.isArray(v) && v.length === 2 ? (v as Cursor) : null;
  } catch {
    return null;
  }
};

export function parseFilters(url: URL): IssueFilters {
  const g = (k: string) => url.searchParams.get(k) || null;
  return {
    code: g("code"),
    severity: g("severity"),
    vendor: g("vendor"),
    type: g("type"),
    status: g("status") === "resolved" ? "resolved" : "open",
    q: g("q"),
    cursor: g("cursor"),
  };
}

export async function listIssues(db: PrismaClient, shopId: string, f: IssueFilters) {
  const codes = f.code ? f.code.split(",").map((c) => c.trim()).filter(Boolean) : [];
  const issueConds: Prisma.Sql[] = [Prisma.sql`i."shopId" = s."shopId"`, Prisma.sql`i."variantId" = s."variantId"`, Prisma.sql`i.status = ${f.status ?? "open"}`];
  if (codes.length) issueConds.push(Prisma.sql`i."ruleCode" IN (${Prisma.join(codes)})`);
  if (f.severity) issueConds.push(Prisma.sql`i.severity = ${f.severity}`);

  const where: Prisma.Sql[] = [
    Prisma.sql`s."shopId" = ${shopId}`,
    Prisma.sql`EXISTS (SELECT 1 FROM "Issue" i WHERE ${Prisma.join(issueConds, " AND ")})`,
  ];
  if (f.euDefault !== undefined && f.euDefault !== null)
    where.push(Prisma.sql`COALESCE((SELECT p."shipsEu" FROM "EuProfileVariant" p WHERE p."shopId" = s."shopId" AND p."variantId" = s."variantId"), ${f.euDefault})`);
  if (f.vendor) where.push(Prisma.sql`s.vendor = ${f.vendor}`);
  if (f.type) where.push(Prisma.sql`s."productType" = ${f.type}`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    where.push(Prisma.sql`(s."productTitle" ILIKE ${like} OR s."variantTitle" ILIKE ${like} OR s.sku ILIKE ${like} OR array_to_string(s.barcodes, ' ') ILIKE ${like})`);
  }
  const cur = dec(f.cursor);
  if (cur) where.push(Prisma.sql`(s."productTitle", s."variantId") > (${cur[0]}, ${cur[1]})`);

  const rows = await db.$queryRaw<
    {
      variantId: string; productId: string; productTitle: string; variantTitle: string; vendor: string;
      sku: string | null; barcodes: string[]; nspid: string | null; imageUrl: string | null; noStandardIdentifier: boolean;
    }[]
  >(Prisma.sql`
    SELECT s."variantId", s."productId", s."productTitle", s."variantTitle", s.vendor, s.sku, s.barcodes, s.nspid, s."imageUrl", s."noStandardIdentifier"
    FROM "VariantSnapshot" s
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY s."productTitle", s."variantId"
    LIMIT ${PAGE_SIZE + 1}`);

  const page = rows.slice(0, PAGE_SIZE);
  const issues = page.length
    ? await db.issue.findMany({
        where: { shopId, status: f.status ?? "open", variantId: { in: page.map((r) => r.variantId) } },
        select: { variantId: true, ruleCode: true, severity: true, message: true },
      })
    : [];
  const by = new Map<string, typeof issues>();
  for (const i of issues) by.set(i.variantId, [...(by.get(i.variantId) ?? []), i]);
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({ ...r, issues: (by.get(r.variantId) ?? []).sort((a, b) => sevRank(a.severity) - sevRank(b.severity)) })),
    nextCursor: rows.length > PAGE_SIZE && last ? enc([last.productTitle, last.variantId]) : null,
  };
}

const sevRank = (s: string) => (s === "error" ? 0 : s === "warning" ? 1 : 2);

export async function filterOptions(db: PrismaClient, shopId: string) {
  const [vendors, types] = await Promise.all([
    db.variantSnapshot.findMany({ where: { shopId, inScope: true }, distinct: ["vendor"], select: { vendor: true }, orderBy: { vendor: "asc" } }),
    db.variantSnapshot.findMany({ where: { shopId, inScope: true }, distinct: ["productType"], select: { productType: true }, orderBy: { productType: "asc" } }),
  ]);
  return { vendors: vendors.map((v) => v.vendor).filter(Boolean), types: types.map((t) => t.productType).filter(Boolean) };
}
