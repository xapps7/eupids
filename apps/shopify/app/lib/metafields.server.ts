// FR-11 / UC-11 / E-09: metafield definitions and existing-key detection.
import type { PrismaClient } from "@prisma/client";
import type { Gql } from "./gql.server";
import { METAFIELD_DEFINITION_CREATE, METAFIELD_DEFINITIONS, SAMPLE_VARIANT_METAFIELDS } from "./queries";

export const NSPID_DEFAULT = { namespace: "customs", key: "manufacturer_product_id", type: "single_line_text_field" };
export const NOSTD = { namespace: "customs", key: "no_standard_identifier", type: "boolean" };

type Def = { id: string; name: string; namespace: string; key: string; type: { name: string } };

/**
 * Create the two definitions if absent. A merchant-owned namespace (not $app) so carriers
 * and other apps can read the values. E-09: if the default NS-PID key exists with a
 * different type, do not overwrite; force the mapping step.
 */
export async function ensureDefinitions(db: PrismaClient, gql: Gql, shopId: string) {
  const data = await gql<{ metafieldDefinitions: { nodes: Def[] } }>(METAFIELD_DEFINITIONS);
  const defs = data.metafieldDefinitions.nodes;
  const find = (ns: string, k: string) => defs.find((d) => d.namespace === ns && d.key === k);

  let mappingRequired = false;
  const ns = find(NSPID_DEFAULT.namespace, NSPID_DEFAULT.key);
  if (!ns) {
    await create(gql, {
      name: "Manufacturer product ID (NS-PID)",
      namespace: NSPID_DEFAULT.namespace,
      key: NSPID_DEFAULT.key,
      type: NSPID_DEFAULT.type,
      description: "The manufacturer's or supplier's own code (model or part number). Used for EU customs declarations.",
      validations: [{ name: "max", value: "70" }],
    });
  } else if (ns.type.name !== NSPID_DEFAULT.type) {
    mappingRequired = true;
  }
  const nb = find(NOSTD.namespace, NOSTD.key);
  if (!nb) {
    await create(gql, {
      name: "No standard barcode (Y081)",
      namespace: NOSTD.namespace,
      key: NOSTD.key,
      type: NOSTD.type,
      description: "True when this item has no GTIN, EAN, UPC or ISBN. Maps to EU exception code Y081.",
    });
  }
  await db.settings.update({ where: { shopId }, data: { mappingRequired } });
  return { mappingRequired };
}

async function create(gql: Gql, definition: Record<string, unknown>) {
  const res = await gql<any>(METAFIELD_DEFINITION_CREATE, {
    definition: { ...definition, ownerType: "PRODUCTVARIANT" },
  });
  const errs = res?.metafieldDefinitionCreate?.userErrors ?? [];
  // TAKEN = already exists (race with a second install callback); fine.
  const real = errs.filter((e: any) => e.code !== "TAKEN");
  if (real.length) throw new Error(real.map((e: any) => e.message).join("; "));
}

const HINT = /(mpn|manufacturer|mfr|model|part)/i;

export type Candidate = { namespace: string; key: string; type: string; samples: string[]; definitionName?: string };

/** UC-11: existing variant metafields that look like a manufacturer code, with sample values. */
export async function detectCandidates(gql: Gql): Promise<Candidate[]> {
  const [defs, sample] = await Promise.all([
    gql<{ metafieldDefinitions: { nodes: Def[] } }>(METAFIELD_DEFINITIONS),
    gql<{ productVariants: { nodes: { metafields: { nodes: { namespace: string; key: string; type: string; value: string }[] } }[] } }>(
      SAMPLE_VARIANT_METAFIELDS,
    ),
  ]);
  const map = new Map<string, Candidate>();
  for (const d of defs.metafieldDefinitions.nodes) {
    if (!HINT.test(d.key) && !HINT.test(d.name)) continue;
    if (d.namespace === NSPID_DEFAULT.namespace && d.key === NSPID_DEFAULT.key) continue;
    map.set(`${d.namespace}.${d.key}`, { namespace: d.namespace, key: d.key, type: d.type.name, samples: [], definitionName: d.name });
  }
  for (const v of sample.productVariants.nodes) {
    for (const m of v.metafields.nodes) {
      if (!HINT.test(m.key)) continue;
      if (m.namespace === NSPID_DEFAULT.namespace && m.key === NSPID_DEFAULT.key) continue;
      const k = `${m.namespace}.${m.key}`;
      const c = map.get(k) ?? { namespace: m.namespace, key: m.key, type: m.type, samples: [] };
      if (c.samples.length < 3 && m.value) c.samples.push(m.value);
      map.set(k, c);
    }
  }
  return [...map.values()];
}
