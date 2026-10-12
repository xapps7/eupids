// Who files the EU customs declaration for the merchant, and how each one picks up the codes.
// Sources (Oct 2026): Zonos "Add EU product identifiers" guide and Passport's PID guide both
// ask Shopify merchants to keep the manufacturer code as an extra variant barcode. DHL, UPS
// and FedEx take m_pid / ns_pid / s_pid per line item in shipment data (e.g. Shipmondo's API).
// Managed Markets / Global-e have not published which field they read.
export type ProviderId = "zonos" | "passport" | "managed_markets" | "shipping_app" | "carrier_portal" | "broker";

export type Provider = {
  id: ProviderId;
  name: string;
  short: string;
  /** Plain steps shown on the Send page. */
  steps: string[];
  /** Copy manufacturer codes into the variant barcode list. */
  barcodes: "recommended" | "optional" | "no";
  file: boolean;
  print: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    id: "zonos",
    name: "Zonos",
    short: "Zonos files the customs data for your EU parcels.",
    steps: [
      "Zonos reads the SKU, the barcode and the manufacturer code from your Shopify variants. Its guide asks for the manufacturer code as an extra barcode.",
      "Click “Copy manufacturer codes to barcodes” below. Your existing barcodes stay first and unchanged.",
      "Ask Zonos support to confirm they pick up the code. Shopify can’t label a barcode as “NS-PID” through apps yet, so it is added without a type.",
    ],
    barcodes: "recommended",
    file: true,
    print: false,
  },
  {
    id: "passport",
    name: "Passport",
    short: "Passport is your cross-border shipping partner.",
    steps: [
      "Passport reads identifiers from your Shopify variants: SKU, barcode, and the manufacturer code as an extra barcode.",
      "Click “Copy manufacturer codes to barcodes” below. Existing barcodes stay first.",
      "Items with no barcode: leave the barcode empty. Passport sends exception code Y081 for them.",
    ],
    barcodes: "recommended",
    file: true,
    print: false,
  },
  {
    id: "managed_markets",
    name: "Shopify Managed Markets / Global-e",
    short: "Shopify Managed Markets (run by Global-e) is the importer for your EU orders.",
    steps: [
      "They haven’t said publicly which Shopify field they read the manufacturer code from.",
      "Download the customs file below and send it to Global-e support. Ask which field they want.",
      "If they say “barcodes”, use the copy button below. If they name a different metafield, set it in Settings.",
    ],
    barcodes: "optional",
    file: true,
    print: false,
  },
  {
    id: "shipping_app",
    name: "A shipping app (ShipStation, Easyship, Shippo…)",
    short: "You buy DHL, UPS or FedEx labels through a shipping app.",
    steps: [
      "Carriers want the three codes per item in the label data. They are called m_pid, ns_pid and s_pid.",
      "Most shipping apps already send your SKU and barcode. Ask yours how to send the manufacturer code: from the product field customs.manufacturer_product_id, from barcodes, or from a product file.",
      "Download the shipping-app file below if they import a product catalogue.",
    ],
    barcodes: "optional",
    file: true,
    print: true,
  },
  {
    id: "carrier_portal",
    name: "I type orders into the carrier’s website",
    short: "You create shipments by hand on DHL, UPS, FedEx or the post office website.",
    steps: [
      "When you create the shipment, each item has fields for its codes. The carrier may call them M-PID, NS-PID and S-PID.",
      "Print the codes sheet for the order below, and copy the codes across item by item.",
      "For an item with no barcode, enter Y081 in the barcode or exception field, if the carrier offers one.",
    ],
    barcodes: "no",
    file: false,
    print: true,
  },
  {
    id: "broker",
    name: "A customs broker",
    short: "A broker or forwarder files declarations for you.",
    steps: [
      "Send your broker the customs file below. It lists every item with its three codes, HS code and country of origin.",
      "Send it again after you fix items, or when you add new products.",
    ],
    barcodes: "no",
    file: true,
    print: true,
  },
];

export const providerById = (id: string | null | undefined) => PROVIDERS.find((p) => p.id === id) ?? null;
