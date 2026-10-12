# PID Ready

Finds and fixes missing EU customs product identifiers (M-PID, NS-PID, S-PID) in a Shopify catalogue before 1 November 2026. Built from `PID Ready - PRD.docx` (Draft v1, 25 Sep 2026).

> PID Ready checks your data. It is not legal or customs advice.

## What's in this repo

| Path | What it is | PRD build step |
| --- | --- | --- |
| `packages/rules` | `@pidready/rules`: the pure TypeScript rule engine (Section 9). No Shopify or DOM code. | 1 |
| `apps/checker` | The free web checker (UC-17). One static HTML file. The CSV never leaves the browser. | 2 |
| `apps/shopify` | The embedded Shopify app (React Router template, Prisma/Postgres, Polaris web components). | 3–8 |

## Quick start (no Shopify needed)

Needs Node 22+ and a local Postgres.

```bash
npm install
npm run build -w @pidready/rules

# Rule engine tests (AT-01)
npm test -w @pidready/rules

# Free checker: builds apps/checker/dist/index.html, then the AT-18 browser test
npm run build -w @pidready/checker
npm run test:e2e -w @pidready/checker

# App: set DATABASE_URL + DIRECT_URL + TOKEN_ENCRYPTION_KEY in apps/shopify/.env (see .env.example)
cd apps/shopify
npx prisma migrate deploy
npm test                 # 26 integration tests (real Postgres + simulated Shopify)
npm run dev:demo         # the whole app on http://localhost:3000 with a demo store
```

`dev:demo` swaps Shopify for an in-memory store (`app/lib/fake-shopify.server.ts`) so every screen works locally. It is disabled when `NODE_ENV=production`.

## Connect to a real Shopify store (about 10 minutes, needs your login)

1. Install the Shopify CLI: `npm install -g @shopify/cli`.
2. In `apps/shopify`, run `npm run config:link` and sign in with your Partner account. Create a new app called **PID Ready**. This fills `client_id` in `shopify.app.toml`.
3. Create a development store in the Partner dashboard if you don't have one.
4. Seed it (AT-00): `node scripts/make-fixture.mjs > fixture.csv`, then Shopify admin → Products → Import.
5. Put your Neon URLs in `apps/shopify/.env`, and add `TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32`).
6. Run `npm run dev` (this is `shopify app dev`). Press `p` to open the app in your dev store. The first scan starts on install.

## Deploy (Neon + ECS)

- **Database (Neon):** `DATABASE_URL` = pooled connection string, `DIRECT_URL` = direct connection string. Migrations run on container start (`prisma migrate deploy`).
- **App (ECS Express or any container host):** `docker build -t pid-ready .` from the repo root. Port 3000. Health check: `GET /`.
- **Environment:** `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES=read_products,write_products,read_inventory,write_inventory`, `DATABASE_URL`, `DIRECT_URL`, `TOKEN_ENCRYPTION_KEY`, `BILLING_TEST=false` (production only).
- Then `npm run deploy` in `apps/shopify` pushes the app config (scopes, webhooks) to Shopify.
- **Free checker:** upload `apps/checker/dist/index.html` to any static host (Cloudflare Pages, Netlify, S3). Set `INSTALL_URL` at build time to your App Store listing.
- The background worker runs inside the web process. Run at least one task; jobs are claimed atomically, so several tasks are safe.

## PRD coverage

| Item | Status | Where |
| --- | --- | --- |
| Section 9 rules R-MPID-01 … R-COO-01, D-01 … D-09 | Done, tested | `packages/rules/src/engine.ts` |
| UC-01 install + first scan (bulk op, JSONL streaming, retry once) | Done, tested | `lib/install.server.ts`, `lib/scan.server.ts` |
| UC-02 dashboard | Done, tested (AT-03) | `routes/app._index.tsx` |
| UC-03 issues list, filters, search, cursor pagination | Done | `routes/app.issues._index.tsx`, `lib/issues.server.ts` |
| UC-04 inline fix, live validation, conflict check | Done, tested (AT-05/06) | `routes/app.variants.$id.tsx`, `lib/writes.server.ts` |
| UC-05 bulk "no barcode" | Done, tested (AT-07) | issues page + `lib/jobs.server.ts` |
| UC-06 CSV round-trip | Done, tested (AT-08) | `routes/app.import.tsx`, `lib/csv.server.ts` |
| UC-07/08/09 supplier requests, public page, review | Done, tested (AT-09/10) | `routes/app.suppliers.*`, `routes/s.$token.tsx` |
| UC-10 settings, re-evaluate with no Shopify call | Done, tested (AT-11) | `routes/app.settings.tsx` |
| UC-11 map an existing metafield, E-09 | Done, tested (AT-12) | `lib/metafields.server.ts` |
| UC-12 guard webhooks, idempotency, regression banner | Done, tested (AT-13) | `routes/webhooks.products.tsx` |
| UC-13 readiness report | Done, tested (AT-14) | `routes/app.report.tsx` |
| UC-14 rescan lock | Done, tested (AT-15) | `lib/scan.server.ts` |
| UC-15 billing gate + resume | Done (logic tested; Shopify approval needs a real store) | `lib/plans.ts`, `routes/app.billing.tsx` |
| UC-16 uninstall + shop/redact | Done, tested (AT-17) | `lib/webhooks.server.ts` |
| UC-17 free checker | Done, tested (AT-18) | `apps/checker` |
| UC-18 weekly email, FR-17/18/19 | Not built (P1/P2) | Settings has the opt-out switch |
| Added 12 Oct: EU focus (only items shipped to EU shoppers, last 60 days) | Done, tested | `lib/eu-orders.server.ts`, dashboard + Issues |
| Added 12 Oct: Send codes page (provider guide, copy manufacturer codes to barcodes, customs file, print sheet) | Done, tested | `routes/app.ship.*`, `lib/providers.ts`, `lib/ship.server.ts` |
| Added 12 Oct: multi-barcode read/write (Admin API 2026-10 `barcodes`) | Done, tested | `lib/snapshot.ts`, `lib/writes.server.ts` |

### Deviations and open items

- **API version:** `2026-10`, passed as a string (the installed library's enum stops at 2026-07). Needed for `ProductVariant.barcodes`.
- **Orders scope (changes the PRD's "no orders" rule):** `read_orders` is used to find which items ship to EU shoppers. Only order number, date, country and line items are read; no names, emails, phones or street addresses (protected customer data level 1). B2B, cancelled and test orders are skipped. `customers/redact` deletes listed orders from the print list.
- **Where carriers read the manufacturer code:** Zonos and Passport ask for it as an extra variant barcode, so the Send page can copy it there (untyped: the API has no NS-PID barcode type). It is still saved in `customs.manufacturer_product_id`.
- **Variant panel** is a full page, not a side panel. Same fields and behaviour.
- **Upgrade flow** opens the Plans page instead of a modal. After approval the blocked save resumes automatically.
- **Collection filter (UC-03)** is not built. Reading collections inside the bulk query needs a nested connection; left out to keep the scan fast.
- **R-NSPID-05** is an added warning code for E-16 (non-Latin characters), pending Q-04.
- **E-05:** Shopify's per-product maximum is 2,048 variants, so the fixture uses 2,048, not 2,100.
- **Q-01** resolved: `ProductVariant.barcodes` (2026-10). Typed UPC/EAN/GTIN/ISBN count as barcodes, ASIN is ignored, an extra untyped non-numeric entry counts as the manufacturer code.
- **AT-19** (token refresh) is handled by the Shopify library's expiring offline tokens. It needs a real store to verify.

## Live deployment (12 Oct 2026)

| Piece | Where |
| --- | --- |
| App server | AWS EC2 `t3a.small` "pidready", us-east-2, **https://pid.revguardlabs.com** (Caddy, auto HTTPS; https://3-151-142-171.sslip.io kept as fallback) |
| Database | Neon project **EUPIDS** (us-east-2), pooled URL for the app, direct URL for migrations |
| Secrets & settings | AWS Systems Manager Parameter Store under `/pidready/` |
| Code | github.com/xapps7/eupids — every push to `main` deploys (GitHub Actions → OIDC role `pidready-github-deploy` → S3 → SSM → server rebuild) |
| Shopify app | "PID Ready" in the RevGuardLabs Dev Dashboard, client ID `14e4b73d7eb1e9959406e22419c06133` |
| Dev store | `pidready-dev.myshopify.com` — app installed, first scan complete |
| Free checker | https://pid.revguardlabs.com/checker/ |
| DNS | GoDaddy, revguardlabs.com: A record `pid` → 3.151.142.171 (Elastic IP) |

Approximate cost: about $17/month (EC2 + public IP + 20 GB disk); Neon on its free tier.

Shopify app version **pid-ready-3** is active (12 Oct 2026): custom domain, 6 webhook subscriptions (products create/update, bulk_operations/finish, app/uninstalled, app/scopes_update, app_subscriptions/update) and the 3 privacy compliance webhooks. To push config changes later: `npx shopify app deploy` from `apps/shopify` (the old `--force` flag no longer exists).

Still to do before App Store submission: declare protected customer data (level 1, orders) in the Dev Dashboard, add `read_orders` to `/pidready/SCOPES`, test a paid plan on the dev store (test charge), then write the listing (name, screenshots, privacy policy URL, support email).
