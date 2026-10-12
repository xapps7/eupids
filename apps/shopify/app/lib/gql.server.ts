// A tiny Admin GraphQL port. Routes pass `fromAdmin(admin)`; background jobs pass
// an offline client; tests pass a fake. Handles THROTTLED with jittered backoff (NFR Rate limits).

export type GqlResult<T = any> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
export type Gql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export class GqlError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown,
  ) {
    super(message);
  }
}

type AdminLike = { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isThrottled(body: GqlResult | undefined, status?: number) {
  if (status === 429) return true;
  return !!body?.errors?.some((e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message));
}

export function withRetry(raw: (q: string, v?: Record<string, unknown>) => Promise<{ status?: number; body?: GqlResult }>, maxAttempts = 6): Gql {
  return async <T,>(query: string, variables?: Record<string, unknown>) => {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: { status?: number; body?: GqlResult };
      try {
        res = await raw(query, variables);
      } catch (e: any) {
        // The Shopify library throws on GraphQL errors; inspect the thrown payload.
        const body = (e?.body ?? e?.response?.body) as GqlResult | undefined;
        if (attempt < maxAttempts && (isThrottled(body, e?.response?.code) || /throttl/i.test(String(e?.message)))) {
          await sleep(backoff(attempt));
          continue;
        }
        throw e;
      }
      if (isThrottled(res.body, res.status) && attempt < maxAttempts) {
        await sleep(backoff(attempt));
        continue;
      }
      if (res.body?.errors?.length) throw new GqlError(res.body.errors.map((x) => x.message).join("; "), res.body.errors);
      return res.body?.data as T;
    }
  };
}

export function backoff(attempt: number) {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export function fromAdmin(admin: AdminLike): Gql {
  return withRetry(async (q, v) => {
    const resp = await admin.graphql(q, v ? { variables: v } : undefined);
    return { status: resp.status, body: (await resp.json()) as GqlResult };
  });
}
