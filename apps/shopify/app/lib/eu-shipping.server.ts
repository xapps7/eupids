// EU focus from the store's shipping settings (Settings → Shipping and delivery).
// A product can reach EU shoppers when its shipping profile has a zone with an EU country
// (or "Rest of world"). Products not in a custom profile follow the general (default) profile.
// Needs read_shipping only: no orders, no customer data.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { DELIVERY_PROFILES, PROFILE_ITEMS } from "./queries";
import { EU_COUNTRIES } from "./shop.server";
import { log } from "./log.server";

type CountryCode = { countryCode: string | null; restOfWorld: boolean };
type ProfileNode = {
  id: string;
  name: string;
  default: boolean;
  profileLocationGroups: { countriesInAnyZone: { country: { code: CountryCode } }[] }[];
};

/** EU countries a profile ships to. "Rest of world" counts as every EU country not listed. */
export function euCountriesOf(p: Pick<ProfileNode, "profileLocationGroups">): string[] {
  const out = new Set<string>();
  for (const g of p.profileLocationGroups) {
    for (const c of g.countriesInAnyZone) {
      const code = c.country.code;
      if (code.restOfWorld) EU_COUNTRIES.forEach((x) => out.add(x));
      else if (code.countryCode && EU_COUNTRIES.includes(code.countryCode)) out.add(code.countryCode);
    }
  }
  return [...out].sort();
}

export function isAccessError(msg: string) {
  return /access denied|not approved|read_shipping|ACCESS_DENIED|permission|scope/i.test(msg);
}

export async function syncEuShipping(db: PrismaClient, gql: Gql, shopId: string) {
  await db.shop.update({ where: { id: shopId }, data: { euSyncStatus: "running", euSyncError: null } });
  try {
    const profiles: ProfileNode[] = [];
    let after: string | null = null;
    do {
      const data: any = await gql(DELIVERY_PROFILES, { after });
      profiles.push(...data.deliveryProfiles.nodes);
      after = data.deliveryProfiles.pageInfo.hasNextPage ? data.deliveryProfiles.pageInfo.endCursor : null;
    } while (after);

    const def = profiles.find((p) => p.default);
    const defaultEu = def ? euCountriesOf(def) : [];
    const all = new Set(defaultEu);
    const rows: { variantId: string; shipsEu: boolean; profile: string }[] = [];
    for (const p of profiles) {
      if (p.default) continue;
      const eu = euCountriesOf(p);
      eu.forEach((x) => all.add(x));
      let cursor: string | null = null;
      do {
        const data: any = await gql(PROFILE_ITEMS, { id: p.id, after: cursor });
        const conn = data.deliveryProfile?.profileItems;
        if (!conn) break;
        for (const item of conn.nodes) {
          for (const v of item.variants.nodes) rows.push({ variantId: v.id, shipsEu: eu.length > 0, profile: p.name });
        }
        cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      } while (cursor);
    }

    await db.$transaction([
      db.euProfileVariant.deleteMany({ where: { shopId } }),
      db.euProfileVariant.createMany({ data: rows.map((r) => ({ shopId, ...r })), skipDuplicates: true }),
      db.shop.update({
        where: { id: shopId },
        data: {
          euSyncStatus: "ok",
          euSyncError: null,
          euSyncedAt: new Date(),
          euDefaultShips: defaultEu.length > 0,
          euCountries: [...all].sort(),
          sellsToEu: all.size > 0,
        },
      }),
    ]);
    log.info("eu_shipping_synced", { shopId, profiles: profiles.length, customItems: rows.length, defaultEu: defaultEu.length });
    return { ok: true as const, profiles: profiles.length, countries: [...all].sort() };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status = isAccessError(msg) ? "no_access" : "failed";
    await db.shop.update({ where: { id: shopId }, data: { euSyncStatus: status, euSyncError: msg.slice(0, 500) } });
    log.warn("eu_shipping_failed", { shopId, status, err: msg });
    return { ok: false as const, status, error: msg };
  }
}

/** Variant ids (in scope) that can ship to the EU. Null when we can't tell. */
export async function euVariantIds(db: PrismaClient, shopId: string): Promise<Set<string> | null> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { euSyncStatus: true, euDefaultShips: true } });
  if (shop?.euSyncStatus !== "ok") return null;
  const [snaps, custom] = await Promise.all([
    db.variantSnapshot.findMany({ where: { shopId, inScope: true }, select: { variantId: true } }),
    db.euProfileVariant.findMany({ where: { shopId }, select: { variantId: true, shipsEu: true } }),
  ]);
  const map = new Map(custom.map((c) => [c.variantId, c.shipsEu]));
  return new Set(snaps.filter((s) => map.get(s.variantId) ?? shop.euDefaultShips).map((s) => s.variantId));
}

/** Is the EU filter in effect? Only if wanted, synced, and some (not all) items can't reach the EU. */
export async function euFilter(db: PrismaClient, shop: { id: string; euSyncStatus: string | null; settings: { euOnly: boolean } | null }) {
  const ids = await euVariantIds(db, shop.id);
  const total = await db.variantSnapshot.count({ where: { shopId: shop.id, inScope: true } });
  const eu = ids?.size ?? null;
  // Only filter when it narrows the list; if everything ships to the EU there is nothing to hide.
  const on = !!shop.settings?.euOnly && ids !== null && eu! > 0 && eu! < total;
  return { on, ids: on ? ids : null, euCount: eu, total };
}
