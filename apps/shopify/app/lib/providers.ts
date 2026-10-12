// Who files EU customs for the merchant, and how each one picks up the three codes.
// Researched 12 Oct 2026 from each provider's own docs (links in `source`). Where a provider
// hasn't published how it reads the codes, `confidence` says so and the steps give the fallback.
import type { CustomsFormat } from "./constants";

export type ProviderGroup = "auto" | "app" | "carrier";
export type Confidence = "confirmed" | "partly" | "not_published";
export type ProviderAction =
  | { kind: "publish" } // write NS_PID barcodes in Shopify
  | { kind: "flavorcloud" } // write FlavorCloud metafields
  | { kind: "file"; format: CustomsFormat; label: string }
  | { kind: "print"; fedex?: boolean; label: string };

export type Provider = {
  id: string;
  name: string;
  group: ProviderGroup;
  /** One line: how the codes reach them. */
  how: string;
  confidence: Confidence;
  steps: string[];
  actions: ProviderAction[];
  source: string;
  /** Their own date, if earlier than 1 Nov. */
  deadline?: string;
};

export const GROUPS: { id: ProviderGroup; title: string; help: string }[] = [
  { id: "auto", title: "Reads your Shopify products", help: "They read the codes straight from your products. PID Ready writes the codes where they look." },
  { id: "app", title: "Shipping apps", help: "You buy labels in a shipping app. Most keep their own product list, so the codes go in by file or by hand." },
  { id: "carrier", title: "Carrier websites, post office, broker", help: "You create shipments yourself. The codes are typed in per item, so PID Ready gives you a sheet to copy from." },
];

const STD: ProviderAction = { kind: "file", format: "standard", label: "Customs file (CSV)" };
const PRINT: ProviderAction = { kind: "print", label: "Print code list" };

export const PROVIDERS: Provider[] = [
  // ---- Reads Shopify directly ----
  {
    id: "zonos",
    name: "Zonos",
    group: "auto",
    how: "Reads SKU and barcodes from Shopify. Manufacturer code = barcode with type NS-PID.",
    confidence: "confirmed",
    steps: [
      "Click “Write codes to Shopify”. Each manufacturer code is added as a barcode with type NS-PID, right after the product’s standard barcode.",
      "Zonos reads the first 5 barcodes of each variant. PID Ready keeps the NS-PID barcode inside the first 5.",
      "If you print labels in the Zonos Dashboard from the Zonos Catalog, also import the Zonos Catalog file.",
    ],
    actions: [{ kind: "publish" }, { kind: "file", format: "zonos", label: "Zonos Catalog file" }],
    source: "https://zonos.com/docs/global-ecommerce/catalog/eu-product-identifiers",
  },
  {
    id: "passport",
    name: "Passport",
    group: "auto",
    how: "Reads SKU and barcodes from Shopify. Manufacturer code = barcode with type NS-PID.",
    confidence: "confirmed",
    deadline: "Passport asks for codes by 22 Oct",
    steps: [
      "Click “Write codes to Shopify”. Each manufacturer code becomes a barcode with type NS-PID.",
      "Items with no barcode: leave the barcode empty and mark “no barcode”. Passport declares Y081 for them.",
    ],
    actions: [{ kind: "publish" }],
    source: "https://help.passportglobal.com/hc/en-us/articles/55783907800595-How-to-add-Product-Identifiers-to-Shopify",
  },
  {
    id: "globale",
    name: "Global-e (Shopify app)",
    group: "auto",
    how: "Reads barcodes from Shopify: NS-PID barcode for the manufacturer code, GTIN/EAN/UPC barcode for the standard one.",
    confidence: "confirmed",
    steps: [
      "Click “Write codes to Shopify”. Global-e reads the NS-PID barcode first, before its own metafields.",
      "Items with no barcode: leave it empty. Global-e declares “no standard barcode” automatically.",
    ],
    actions: [{ kind: "publish" }],
    source: "https://docs.global-e.com/eu-product-identifiers-setup-shopify",
  },
  {
    id: "managed_markets",
    name: "Shopify Managed Markets",
    group: "auto",
    how: "Not published yet. Shopify’s own NS-PID barcode type is the most likely source.",
    confidence: "not_published",
    steps: [
      "Click “Write codes to Shopify” so the codes sit in Shopify’s own NS-PID and barcode fields.",
      "Shopify hasn’t said which fields Managed Markets reads. Download the customs file and send it to Shopify Support. Ask them to confirm.",
    ],
    actions: [{ kind: "publish" }, STD],
    source: "https://help.shopify.com/en/manual/international/managed-markets",
  },
  {
    id: "flavorcloud",
    name: "FlavorCloud",
    group: "auto",
    how: "Reads its own variant metafields: flavorcloud.ns_manufacturer_pid, std_manufacturer_pid and std_manufacturer_pid_type.",
    confidence: "partly",
    steps: [
      "Click “Write FlavorCloud fields”. PID Ready fills the three FlavorCloud fields on every item. Items marked “no barcode” get type NONE, which FlavorCloud needs.",
      "FlavorCloud’s guide shows two namespaces (custom and flavorcloud). PID Ready uses flavorcloud, as its field reference says. Ask FlavorCloud to confirm.",
    ],
    actions: [{ kind: "flavorcloud" }, { kind: "publish" }],
    source: "https://flavorcloud.com/resources/knowledge-base/eu-product-identifiers-shopify-setup",
  },

  // ---- Shipping apps ----
  {
    id: "shipstation",
    name: "ShipStation",
    group: "app",
    how: "Own product list. SKU syncs from Shopify; barcode and manufacturer code are filled in ShipStation.",
    confidence: "partly",
    steps: [
      "In ShipStation, open Products. Export them, fill the barcode (General tab) and “Manufacturer Product Identification Code” (Customs tab) from PID Ready’s file, and import again.",
      "Use “Apply changes to open orders” so orders already waiting get the codes.",
      "Using the ShipStation API? Send manufacturer_ns_product_id, manufacturer_product_id and manufacturer_product_id_type per item.",
    ],
    actions: [{ kind: "file", format: "shipping_app", label: "Codes by SKU (CSV)" }, PRINT],
    source: "https://help.shipstation.com/hc/en-us/articles/25007865974299-Country-Specific-Cross-Border-Shipping-Requirements",
  },
  {
    id: "veeqo",
    name: "Veeqo",
    group: "app",
    how: "Own product list. Imports a CSV with sku_code, upc_code and model_number.",
    confidence: "confirmed",
    steps: [
      "Download the Veeqo file. It has Veeqo’s exact columns: sku_code, upc_code, upc_code_type, model_number.",
      "In Veeqo, go to Products → Import and upload it. Veeqo saves the codes on each product and reuses them on every shipment.",
    ],
    actions: [{ kind: "file", format: "veeqo", label: "Veeqo import file" }],
    source: "https://help.veeqo.com/en/articles/17263145-shipping-to-eu-customs-requirements-2026",
  },
  {
    id: "shippo",
    name: "Shippo",
    group: "app",
    how: "Codes go on each customs item. From 1 Nov, Shippo refuses EU labels without a manufacturer code.",
    confidence: "partly",
    steps: [
      "Each customs item has SKU, Manufacturer code and Standard code fields. Fill them from PID Ready’s file or print list.",
      "Leave the standard code empty when there is no barcode.",
      "Using the Shippo API? Send sku_code, manufacturer_code and manufacturer_standard_code on each customs item.",
    ],
    actions: [{ kind: "file", format: "shipping_app", label: "Codes by SKU (CSV)" }, PRINT],
    source: "https://support.goshippo.com/hc/en-us/articles/56535213758619-EU-customs-update-new-product-identifier-requirements-starting-November-1-2026",
  },
  {
    id: "sendcloud",
    name: "Sendcloud",
    group: "app",
    how: "SKU and EAN sync from Shopify. The manufacturer code is entered per item on the shipment.",
    confidence: "partly",
    steps: [
      "Sendcloud imports your SKU and barcode from Shopify. Its product list has no manufacturer-code column yet.",
      "When you create an international shipment, fill “Manufacturer product identifier” for each item from PID Ready’s list.",
      "Using the Sendcloud API? Send sku, manufacturer_product_id and manufacturer_product_id_std on each parcel item.",
    ],
    actions: [PRINT, { kind: "file", format: "shipping_app", label: "Codes by SKU (CSV)" }],
    source: "https://support.sendcloud.com/hc/en-us/articles/24259096630033-How-to-create-an-international-shipment-in-Sendcloud",
  },
  {
    id: "easyship",
    name: "Easyship",
    group: "app",
    how: "Own product list with fields for manufacturer part number and GTIN.",
    confidence: "partly",
    steps: [
      "In Easyship, open Products and download the import template. Copy the manufacturer code into “manufacturer part number” and the barcode into GTIN, matching by SKU.",
      "Easyship hasn’t published a PID help page yet. Check one EU shipment before 1 Nov.",
    ],
    actions: [{ kind: "file", format: "shipping_app", label: "Codes by SKU (CSV)" }],
    source: "https://developers.easyship.com/reference/products_update",
  },
  {
    id: "other_app",
    name: "Other app (ShipBob, ShipHero, Ordoro, Starshipit, Shiprocket X…)",
    group: "app",
    how: "No published support for the codes yet.",
    confidence: "not_published",
    steps: [
      "Send the customs file to your app’s support and ask where the three codes go. They may only accept them per shipment for now.",
      "Until they answer, keep the print list next to whoever books EU shipments.",
    ],
    actions: [STD, PRINT],
    source: "",
  },

  // ---- Carrier tools ----
  {
    id: "fedex",
    name: "FedEx (Ship Manager on fedex.com)",
    group: "carrier",
    how: "One “Product Identifier (PID)” field per item, in this format: M-PID… NS-PID… S-PID… (S-PIDNO if no barcode).",
    confidence: "confirmed",
    deadline: "FedEx requires codes from 26 Oct",
    steps: [
      "Print the FedEx list. Each item has its PID text ready, e.g. “M-PIDIL-TA-3-2 NS-PIDTX-882 S-PID8901234567890”.",
      "In Ship Manager: Package contents → Add item → Product details → paste it into “Product Identifier (PID)”.",
      "Using the FedEx Ship API? Send merchantProductId, nonStandardManufacturerProductId and standardManufacturerProductId in regulatoryDetails.",
    ],
    actions: [{ kind: "print", fedex: true, label: "Print FedEx list" }, STD],
    source: "https://www.fedex.com/content/dam/fedex/eu-europe/downloads/EU-PID-Guide.pdf",
  },
  {
    id: "ups",
    name: "UPS (ups.com, WorldShip)",
    group: "carrier",
    how: "Three fields per item on the commercial invoice: Merchant, Manufacturer and Standardized Product ID (“No” if no barcode).",
    confidence: "confirmed",
    deadline: "UPS checks codes from 25 Oct",
    steps: [
      "On ups.com the three fields appear when you fill the commercial invoice. In WorldShip they are under Customs Documentation.",
      "Copy them from the UPS file or print list. Write “No” in Standardized Product ID when there is no barcode.",
      "Using the UPS API? Send ProductIdentifier with type codes 0100 (merchant), 0200 (manufacturer) and 0300 (standard).",
    ],
    actions: [{ kind: "file", format: "ups", label: "UPS file" }, PRINT],
    source: "https://www.ups.com/us/en/shipping/international-shipping/tariffs/de-minimis",
  },
  {
    id: "dhl",
    name: "DHL Express (MyDHL+)",
    group: "carrier",
    how: "Codes per item on the shipment. DHL hasn’t published the MyDHL+ field labels.",
    confidence: "partly",
    steps: [
      "Enter the three codes for each item when you create the shipment. Use the print list.",
      "Using the MyDHL API? Send them as line-item references: ABW = SKU, MF = manufacturer code, SRV = barcode.",
    ],
    actions: [PRINT, STD],
    source: "https://www.dhl.com/global-en/microsites-2-0/core/us-tariffs/product-identifiers.html",
  },
  {
    id: "royalmail",
    name: "Royal Mail (Click & Drop)",
    group: "carrier",
    how: "Order items have SKU and “Reference ID” (manufacturer’s product reference).",
    confidence: "partly",
    steps: [
      "Put the manufacturer code in “Reference ID” for each item. SKU goes in “Identifier (SKU)”.",
      "Royal Mail’s customs guide was not public when we checked. Confirm with Royal Mail where the barcode goes.",
    ],
    actions: [PRINT],
    source: "https://help.parcel.royalmail.com/hc/en-gb/articles/360000250093-Order-Import-spreadsheet-field-specifications",
  },
  {
    id: "post",
    name: "Post office (USPS, India Post, Canada Post…)",
    group: "carrier",
    how: "No published format yet. Postal customs data comes from the CN23 / electronic customs form.",
    confidence: "not_published",
    steps: [
      "Add the three codes to each item’s description on the customs form, in this order: SKU, manufacturer code, barcode (or “no barcode”).",
      "Ask your post office whether its booking system has PID fields yet.",
    ],
    actions: [PRINT],
    source: "",
  },
  {
    id: "broker",
    name: "Customs broker or forwarder",
    group: "carrier",
    how: "Send them the customs file.",
    confidence: "confirmed",
    steps: [
      "Send the customs file. It lists every item with its three codes, HS code and country of origin.",
      "Send it again after you fix items or add products.",
    ],
    actions: [STD],
    source: "",
  },
];

export const providerById = (id: string | null | undefined) => PROVIDERS.find((p) => p.id === id) ?? null;
export const parseProviders = (s: string | null | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter((x) => providerById(x));
export const providerNames = (s: string | null | undefined) => parseProviders(s).map((id) => providerById(id)!.name);
