import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { EncryptedSessionStorage } from "./lib/encrypted-session-storage.server";
import { onInstalled } from "./lib/install.server";
import { fromAdmin } from "./lib/gql.server";
import { PLANS } from "./lib/plans";

// Section 10 — billed through Shopify; 7-day trial once per shop (enforced in billing.server.ts).
const billing = Object.fromEntries(
  PLANS.filter((p) => p.price > 0).map((p) => [
    p.name,
    {
      trialDays: 7,
      lineItems: [{ amount: p.price, currencyCode: "USD", interval: BillingInterval.Every30Days as const }],
    },
  ]),
) as Record<string, { trialDays: number; lineItems: { amount: number; currencyCode: string; interval: BillingInterval.Every30Days }[] }>;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  // PRD §8: latest stable version. The installed library's enum stops at 2026-07, but it
  // accepts any version string; 2026-10 is needed for ProductVariant.barcodes.
  apiVersion: "2026-10" as ApiVersion,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(new PrismaSessionStorage(prisma)),
  distribution: AppDistribution.AppStore,
  billing,
  future: {
    // §8 Auth: new public apps must use expiring offline tokens (60 min) with refresh.
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      await onInstalled(prisma, session.shop, fromAdmin(admin));
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = "2026-10" as ApiVersion;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

/** Offline Admin client for background work (jobs, webhooks, polling). */
export async function offlineGql(shopDomain: string) {
  const { admin } = await shopify.unauthenticated.admin(shopDomain);
  return fromAdmin(admin);
}
