// PRD Section 8 — Admin GraphQL documents. Admin API 2026-10.
// Q-01 resolved: 2026-10 adds ProductVariant.barcodes (up to 20, optional type). We read both
// the list and the deprecated single `barcode` (first entry) so older data still works.

export type NspidKey = { namespace: string; key: string };

const VARIANT_FIELDS = (k: NspidKey) => `
  id sku barcode updatedAt title
  barcodes(first: 20) { nodes { value type } }
  product {
    id title vendor productType status isGiftCard
    featuredMedia { preview { image { url } } }
  }
  inventoryItem { id requiresShipping harmonizedSystemCode countryCodeOfOrigin }
  nspid: metafield(namespace: ${JSON.stringify(k.namespace)}, key: ${JSON.stringify(k.key)}) { value }
  noStd: metafield(namespace: "customs", key: "no_standard_identifier") { value }
`;

/** UC-01 / FR-02: one bulk operation over all variants. Rebuilt when the NS-PID key is remapped (UC-11). */
export function bulkScanQuery(k: NspidKey) {
  return `{ productVariants { edges { node { ${VARIANT_FIELDS(k)} } } } }`;
}

export const BULK_RUN = `#graphql
mutation RunScan($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

export const BULK_STATUS = `#graphql
query BulkStatus($id: ID!) {
  node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } }
}`;

export const BULK_CANCEL = `#graphql
mutation CancelBulk($id: ID!) { bulkOperationCancel(id: $id) { bulkOperation { id status } userErrors { message } } }`;

export function variantQuery(k: NspidKey) {
  return `#graphql
query OneVariant($id: ID!) { productVariant(id: $id) { ${VARIANT_FIELDS(k)} } }`;
}

/** UC-12 guard / E-05: all variants of one product, paginated. */
export function productVariantsQuery(k: NspidKey) {
  return `#graphql
query ProductVariants($q: String!, $after: String) {
  productVariants(first: 100, after: $after, query: $q) {
    nodes { ${VARIANT_FIELDS(k)} }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

export const VARIANTS_BULK_UPDATE = `#graphql
mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku updatedAt }
    userErrors { field message code }
  }
}`;

export const METAFIELDS_SET = `#graphql
mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key value owner { ... on ProductVariant { id } } }
    userErrors { field message code }
  }
}`;

export const METAFIELDS_DELETE = `#graphql
mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
  metafieldsDelete(metafields: $metafields) {
    deletedMetafields { key namespace ownerId }
    userErrors { field message }
  }
}`;

export const INVENTORY_ITEM_UPDATE = `#graphql
mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) {
    inventoryItem { id harmonizedSystemCode countryCodeOfOrigin }
    userErrors { field message }
  }
}`;

export const METAFIELD_DEFINITIONS = `#graphql
query Definitions {
  metafieldDefinitions(ownerType: PRODUCTVARIANT, first: 250) {
    nodes { id name namespace key type { name } }
  }
}`;

export const METAFIELD_DEFINITION_CREATE = `#graphql
mutation CreateDefinition($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id namespace key }
    userErrors { field message code }
  }
}`;

/** UC-11: sample variant metafields to find likely manufacturer-code keys. */
export const SAMPLE_VARIANT_METAFIELDS = `#graphql
query SampleMetafields {
  productVariants(first: 50) {
    nodes { id metafields(first: 25) { nodes { namespace key type value } } }
  }
}`;

/**
 * EU focus: recent orders with country and line items. No names, emails, phones or street
 * addresses are requested (protected customer data level 1 only). Page size keeps the
 * query cost under the 1,000-point limit.
 */
export const EU_ORDERS = `#graphql
query EuOrders($q: String!, $after: String) {
  orders(first: 25, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    nodes {
      id name createdAt cancelledAt test
      shippingAddress { countryCodeV2 }
      purchasingEntity { __typename }
      lineItems(first: 30) {
        nodes {
          title variantTitle sku quantity
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const SHOP_INFO = `#graphql
query ShopInfo { shop { name myshopifyDomain shipsToCountries } }`;

export function nodesQuery(k: NspidKey) {
  return `#graphql
query VariantNodes($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS(k)} } } }`;
}
