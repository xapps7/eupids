// An in-memory stand-in for the Admin GraphQL API, covering exactly the operations
// PID Ready uses. Used by integration tests and by local dev mode (PID_DEV_SHOP) so
// every screen can be exercised without a Shopify store. Never used in production.
import type { Gql } from "./gql.server";

export type FakeVariant = {
  id: string;
  productId: string;
  productTitle: string;
  title: string;
  vendor: string;
  productType: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  isGiftCard: boolean;
  requiresShipping: boolean;
  sku: string | null;
  barcode: string | null;
  barcodeType?: string | null;
  /** Extra barcodes after the first (2026-10 multi-barcode). */
  extraBarcodes?: { value: string; type: string | null }[];
  hsCode: string | null;
  countryOfOrigin: string | null;
  updatedAt: string;
  metafields: Record<string, { type: string; value: string }>; // "ns.key"
};

export type FakeProfile = { id: string; name: string; default: boolean; countries: string[]; restOfWorld?: boolean; variantIds: string[] };

export type FakeDefinition = { id: string; name: string; namespace: string; key: string; type: { name: string } };

export class FakeShopify {
  variants = new Map<string, FakeVariant>();
  definitions: FakeDefinition[] = [];
  bulkOps = new Map<string, { status: string; url: string | null; objectCount: number }>();
  calls: { op: string; variables?: any }[] = [];
  profiles: FakeProfile[] = [{ id: "gid://shopify/DeliveryProfile/1", name: "General profile", default: true, countries: ["US", "GB", "DE", "FR", "NL"], variantIds: [] }];
  denyShipping = false;
  shipsTo = ["US", "GB", "DE", "FR"];
  failNextBulk = 0;
  throttleNext = 0;
  private seq = 1 + Math.floor(Math.random() * 1e6) * 10_000; // GIDs are globally unique in Shopify
  private clock = Date.parse("2026-09-20T00:00:00Z");

  tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  add(v: Partial<FakeVariant> & { productId: string }) {
    const id = v.id ?? `gid://shopify/ProductVariant/${this.seq++}`;
    const full: FakeVariant = {
      id,
      productTitle: "Product",
      title: "Default Title",
      vendor: "Vendor",
      productType: "",
      status: "ACTIVE",
      isGiftCard: false,
      requiresShipping: true,
      sku: null,
      barcode: null,
      hsCode: null,
      countryOfOrigin: null,
      metafields: {},
      updatedAt: this.tick(),
      ...v,
    };
    this.variants.set(id, full);
    return full;
  }

  /** Simulate the merchant editing in Shopify admin (UC-04 A1). */
  touch(id: string, patch: Partial<FakeVariant> = {}) {
    const v = this.variants.get(id)!;
    Object.assign(v, patch, { updatedAt: this.tick() });
  }

  node(v: FakeVariant, nsKey = "customs.manufacturer_product_id") {
    return {
      id: v.id,
      sku: v.sku,
      barcode: v.barcode,
      barcodes: { nodes: [...(v.barcode ? [{ value: v.barcode, type: (v.barcodeType ?? null) as string | null }] : []), ...(v.extraBarcodes ?? [])] },
      updatedAt: v.updatedAt,
      title: v.title,
      product: {
        id: v.productId,
        title: v.productTitle,
        vendor: v.vendor,
        productType: v.productType,
        status: v.status,
        isGiftCard: v.isGiftCard,
        featuredMedia: null,
      },
      inventoryItem: {
        id: v.id.replace("ProductVariant", "InventoryItem"),
        requiresShipping: v.requiresShipping,
        harmonizedSystemCode: v.hsCode,
        countryCodeOfOrigin: v.countryOfOrigin,
      },
      nspid: v.metafields[nsKey] ? { value: v.metafields[nsKey]!.value } : null,
      noStd: v.metafields["customs.no_standard_identifier"] ? { value: v.metafields["customs.no_standard_identifier"]!.value } : null,
    };
  }

  private nsKeyFrom(query: string) {
    const m = /nspid: metafield\(namespace: "([^"]+)", key: "([^"]+)"\)/.exec(query);
    return m ? `${m[1]}.${m[2]}` : "customs.manufacturer_product_id";
  }

  gql: Gql = async <T,>(query: string, variables: Record<string, any> = {}): Promise<T> => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    this.calls.push({ op, variables });
    if (this.throttleNext > 0) {
      this.throttleNext--;
      const err: any = new Error("Throttled");
      err.body = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };
      throw err;
    }
    return this.handle(op, query, variables) as T;
  };

  private handle(op: string, query: string, vars: any): any {
    switch (op) {
      case "ShopInfo":
        return { shop: { name: "Indigo Loom", myshopifyDomain: "indigo-loom.myshopify.com", shipsToCountries: this.shipsTo } };
      case "Definitions":
        return { metafieldDefinitions: { nodes: this.definitions } };
      case "CreateDefinition": {
        const d = vars.definition;
        if (this.definitions.some((x) => x.namespace === d.namespace && x.key === d.key))
          return { metafieldDefinitionCreate: { createdDefinition: null, userErrors: [{ message: "Key taken", code: "TAKEN" }] } };
        const def = { id: `gid://shopify/MetafieldDefinition/${this.seq++}`, name: d.name, namespace: d.namespace, key: d.key, type: { name: d.type } };
        this.definitions.push(def);
        return { metafieldDefinitionCreate: { createdDefinition: def, userErrors: [] } };
      }
      case "SampleMetafields":
        return {
          productVariants: {
            nodes: [...this.variants.values()].slice(0, 50).map((v) => ({
              id: v.id,
              metafields: { nodes: Object.entries(v.metafields).map(([k, m]) => ({ namespace: k.split(".")[0], key: k.split(".")[1], type: m.type, value: m.value })) },
            })),
          },
        };
      case "RunScan": {
        if (this.failNextBulk > 0) {
          this.failNextBulk--;
          return { bulkOperationRunQuery: { bulkOperation: null, userErrors: [{ message: "Simulated failure" }] } };
        }
        const nsKey = this.nsKeyFrom(vars.query);
        const lines = [...this.variants.values()].map((v) => JSON.stringify(this.node(v, nsKey))).join("\n");
        const id = `gid://shopify/BulkOperation/${this.seq++}`;
        const url = this.variants.size ? `data:application/jsonl;base64,${Buffer.from(lines).toString("base64")}` : null;
        this.bulkOps.set(id, { status: "COMPLETED", url, objectCount: this.variants.size });
        return { bulkOperationRunQuery: { bulkOperation: { id, status: "CREATED" }, userErrors: [] } };
      }
      case "BulkStatus": {
        const b = this.bulkOps.get(vars.id);
        return { node: b ? { id: vars.id, status: b.status, errorCode: null, objectCount: b.objectCount, url: b.url, partialDataUrl: null } : null };
      }
      case "CancelBulk":
        return { bulkOperationCancel: { bulkOperation: { id: vars.id, status: "CANCELING" }, userErrors: [] } };
      case "VariantNodes":
      case "OneVariant": {
        const nsKey = this.nsKeyFrom(query);
        if (op === "OneVariant") {
          const v = this.variants.get(vars.id);
          return { productVariant: v ? this.node(v, nsKey) : null };
        }
        return { nodes: (vars.ids as string[]).map((id) => (this.variants.has(id) ? this.node(this.variants.get(id)!, nsKey) : null)) };
      }
      case "ProductVariants": {
        const nsKey = this.nsKeyFrom(query);
        const pid = String(vars.q).replace("product_id:", "");
        const all = [...this.variants.values()].filter((v) => v.productId.endsWith(`/${pid}`));
        const start = vars.after ? Number(vars.after) : 0;
        const page = all.slice(start, start + 100);
        return {
          productVariants: {
            nodes: page.map((v) => this.node(v, nsKey)),
            pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) },
          },
        };
      }
      case "UpdateVariants": {
        const errors: any[] = [];
        (vars.variants as any[]).forEach((u, i) => {
          const v = this.variants.get(u.id);
          if (!v) return errors.push({ field: ["variants", String(i)], message: "Variant not found" });
          if (u.inventoryItem?.sku === "REJECT-ME") return errors.push({ field: ["variants", String(i), "sku"], message: "SKU rejected by Shopify" });
          if ("barcode" in u) {
            v.barcode = u.barcode || null;
            v.barcodeType = null;
          }
          if (Array.isArray(u.barcodes)) {
            if ("barcode" in u) return errors.push({ field: ["variants", String(i), "barcodes"], message: "Can't set barcode and barcodes together" });
            if (u.barcodes.length > 20) return errors.push({ field: ["variants", String(i), "barcodes"], message: "At most 20 barcodes" });
            v.barcode = u.barcodes[0]?.value ?? null;
            v.barcodeType = u.barcodes[0]?.type ?? null;
            v.extraBarcodes = u.barcodes.slice(1).map((b: any) => ({ value: b.value, type: b.type ?? null }));
          }
          if (u.inventoryItem && "sku" in u.inventoryItem) v.sku = u.inventoryItem.sku || null;
          v.updatedAt = this.tick();
        });
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: errors } };
      }
      case "SetMetafields": {
        if ((vars.metafields as any[]).length > 25) throw new Error("metafieldsSet accepts at most 25 metafields");
        for (const m of vars.metafields) {
          const v = this.variants.get(m.ownerId);
          if (v) {
            v.metafields[`${m.namespace}.${m.key}`] = { type: m.type, value: m.value };
            v.updatedAt = this.tick();
          }
        }
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      }
      case "DeleteMetafields": {
        for (const m of vars.metafields) {
          const v = this.variants.get(m.ownerId);
          if (v) {
            delete v.metafields[`${m.namespace}.${m.key}`];
            v.updatedAt = this.tick();
          }
        }
        return { metafieldsDelete: { deletedMetafields: vars.metafields, userErrors: [] } };
      }
      case "UpdateInventoryItem": {
        const v = [...this.variants.values()].find((x) => x.id.replace("ProductVariant", "InventoryItem") === vars.id);
        if (v) {
          if ("harmonizedSystemCode" in vars.input) v.hsCode = vars.input.harmonizedSystemCode;
          if ("countryCodeOfOrigin" in vars.input) v.countryOfOrigin = vars.input.countryCodeOfOrigin;
          v.updatedAt = this.tick();
        }
        return { inventoryItemUpdate: { inventoryItem: { id: vars.id }, userErrors: [] } };
      }
      case "DeliveryProfiles": {
        if (this.denyShipping) throw new Error("Access denied for deliveryProfiles field. Required access: `read_shipping` access scope.");
        return {
          deliveryProfiles: {
            nodes: this.profiles.map((p) => ({
              id: p.id,
              name: p.name,
              default: p.default,
              profileLocationGroups: [
                {
                  countriesInAnyZone: [
                    ...p.countries.map((c) => ({ country: { code: { countryCode: c, restOfWorld: false } } })),
                    ...(p.restOfWorld ? [{ country: { code: { countryCode: null, restOfWorld: true } } }] : []),
                  ],
                },
              ],
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      case "ProfileItems": {
        const p = this.profiles.find((x) => x.id === vars.id);
        if (!p) return { deliveryProfile: null };
        const byProduct = new Map<string, string[]>();
        for (const vid of p.variantIds) {
          const v = this.variants.get(vid);
          if (!v) continue;
          byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), vid]);
        }
        const all = [...byProduct.entries()];
        const start = vars.after ? Number(vars.after) : 0;
        const page = all.slice(start, start + 25);
        return {
          deliveryProfile: {
            profileItems: {
              nodes: page.map(([pid, vids]) => ({ product: { id: pid }, variants: { nodes: vids.map((id) => ({ id })) } })),
              pageInfo: { hasNextPage: start + 25 < all.length, endCursor: String(start + 25) },
            },
          },
        };
      }
      default:
        throw new Error(`FakeShopify: unhandled operation ${op}`);
    }
  }

  countOps(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

/** A realistic demo catalogue: a home-textiles store with the usual gaps. */
export function seedDemo(f: FakeShopify, variantsTarget = 60) {
  const vendors = ["Jaipur Block Prints", "Panipat Weaves", "Kanpur Cotton Mills", "Sanganer Crafts", "Indigo Loom"];
  const types = ["Bedsheets", "Towels", "Cushions", "Table linen", "Rugs", "Quilts"];
  const sizes = ["Single", "Double", "King", "Queen"];
  let p = 1;
  let n = 0;
  const ean = (seed: number) => {
    const body = "890" + String(1234500000 + seed * 7919).slice(-9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
    return body + ((10 - (sum % 10)) % 10);
  };
  while (n < variantsTarget) {
    const vendor = vendors[p % vendors.length]!;
    const type = types[p % types.length]!;
    const productId = `gid://shopify/Product/${1000 + p}`;
    const count = 1 + (p % 4);
    for (let i = 0; i < count && n < variantsTarget; i++, n++) {
      const seed = p * 10 + i;
      const sku = seed % 17 === 0 ? null : `IL-${type.slice(0, 2).toUpperCase()}-${p}-${i}`;
      const barcode = seed % 5 === 0 ? null : seed % 11 === 0 ? ean(seed).slice(0, -1) + "0" : seed % 13 === 0 ? "B08N5WRWNW" : ean(seed);
      const metafields: FakeVariant["metafields"] = {};
      if (vendor === "Jaipur Block Prints" && seed % 3 !== 0) metafields["customs.manufacturer_product_id"] = { type: "single_line_text_field", value: `JBP-${p}${i}` };
      if (vendor === "Indigo Loom" && sku) metafields["customs.manufacturer_product_id"] = { type: "single_line_text_field", value: sku };
      f.add({
        productId,
        productTitle: `${["Indigo", "Kantha", "Waffle", "Chambray", "Dhurrie", "Dabu"][p % 6]} ${type.replace(/s$/, "")}`,
        title: count > 1 ? sizes[i]! : "Default Title",
        vendor,
        productType: type,
        sku,
        barcode,
        hsCode: seed % 4 === 0 ? null : "630221",
        countryOfOrigin: seed % 6 === 0 ? null : "IN",
        metafields,
      });
    }
    p++;
  }
  // Demo shipping: rugs are heavy and ship only within India (a custom profile).
  const rugs = [...f.variants.values()].filter((v) => v.productType === "Rugs").map((v) => v.id);
  f.profiles.push({ id: "gid://shopify/DeliveryProfile/2", name: "Rugs (India only)", default: false, countries: ["IN"], variantIds: rugs });
  f.add({ productId: "gid://shopify/Product/9001", productTitle: "Gift Card", vendor: "Indigo Loom", isGiftCard: true, requiresShipping: false });
  f.add({ productId: "gid://shopify/Product/9002", productTitle: "Muslin Swaddle (draft)", vendor: "Kanpur Cotton Mills", status: "DRAFT" });
}
