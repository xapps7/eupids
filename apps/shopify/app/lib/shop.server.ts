import type { PrismaClient } from "@prisma/client";

/** Every query is scoped by shop id (NFR Tenant isolation). This is the only lookup by domain. */
export async function getShop(db: PrismaClient, domain: string) {
  const shop = await db.shop.upsert({
    where: { domain },
    update: {},
    create: { domain, settings: { create: {} } },
    include: { settings: true },
  });
  if (!shop.settings) {
    const settings = await db.settings.create({ data: { shopId: shop.id } });
    return { ...shop, settings };
  }
  return shop as typeof shop & { settings: NonNullable<typeof shop.settings> };
}

export async function findShop(db: PrismaClient, domain: string) {
  return db.shop.findUnique({ where: { domain }, include: { settings: true } });
}

export async function audit(
  db: PrismaClient,
  row: {
    shopId: string;
    actor: string;
    action: string;
    variantId?: string | null;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    count?: number | null;
  },
) {
  await db.auditLog.create({ data: row });
}

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];
