// UC-01: after OAuth — shop row, metafield definitions, first scan.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { getShop, EU_COUNTRIES } from "./shop.server";
import { ensureDefinitions } from "./metafields.server";
import { queueEuSync, startScan } from "./scan.server";
import { SHOP_INFO } from "./queries";
import { log } from "./log.server";

export async function onInstalled(db: PrismaClient, domain: string, gql: Gql) {
  const shop = await getShop(db, domain);
  const reinstall = !shop.active;
  await db.shop.update({ where: { id: shop.id }, data: { active: true, uninstalledAt: null } });

  try {
    const info = await gql<{ shop: { name: string; shipsToCountries: string[] } }>(SHOP_INFO);
    const sellsToEu = info.shop.shipsToCountries.some((c) => EU_COUNTRIES.includes(c));
    await db.shop.update({ where: { id: shop.id }, data: { name: info.shop.name, sellsToEu } });
  } catch (e) {
    log.warn("shop_info_failed", { shopId: shop.id, err: String(e) });
  }

  try {
    await ensureDefinitions(db, gql, shop.id);
  } catch (e) {
    log.error("definitions_failed", { shopId: shop.id, err: String(e) });
  }

  const anyScan = await db.scan.findFirst({ where: { shopId: shop.id } });
  if (!anyScan || reinstall) {
    await startScan(db, gql, shop.id);
  } else if (shop.euSyncStatus !== "ok") {
    // Existing shop opening the app after approving new scopes: try the EU view again.
    await queueEuSync(db, shop.id);
  }
  return shop;
}
