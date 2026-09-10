# Deploying to Dokploy

The bot is a **worker**, not a web app: one Node process running the main
Discord client plus four ticker-bot clients, all outbound-only (Discord
gateway, Helius, api.hylo.so, Jupiter, X). It needs **no ports, no domain, no
TLS** — only its Postgres database.

Production runs the TypeScript source through **tsx without `--watch`** (the
same loader used in dev, minus the watcher). The `tsc`→`dist` path is
deliberately not used: tsc does not rewrite the `@/*` path aliases into the
emitted output and does not copy `src/services/onchain/idl/hylo_exchange.json`
into dist, so a built image would crash on boot.

**The one operational rule: never run two instances of the same Discord
token.** Two instances double-post every alert and fight over ticker
nicknames. Stop the old instance before (or immediately after) the dokploy
one goes live, and keep dokploy replicas at 1.

## What's in this repo for the deploy

| File | Purpose |
|---|---|
| `Dockerfile` | Production image: full deps, `prisma generate`, boots with `prisma migrate deploy` then `node --import tsx/esm src/index.ts` (no `--watch`) |
| `docker-compose.yml` | Dokploy "Compose" service: Postgres 16 + bot, shared volume, healthcheck, dependency ordering |
| `.dockerignore` | Keeps `.env`, git, tests, and build output out of the image |

## Steps to go live

### 1. Push the repo to git
```bash
# inside the project folder
git remote add origin git@github.com:<you>/hylo-asset-live-bot.git
git push -u origin main
```
`.env` is gitignored — secrets travel only via Dokploy's environment settings.

### 2. Create the stack in Dokploy
1. Dokploy → **Projects** → new project (e.g. "hylo").
2. Create a **Compose** service → point it at this repo/branch → Dokploy reads
   `docker-compose.yml` (bot + Postgres, one deploy).
3. In the service's **Environment** tab, add every variable from the local
   `.env` **except** `DATABASE_URL` and `NODE_ENV` (compose sets those), plus
   one new one:
   - `DB_PASSWORD` — this is a password you CREATE, not fetch: generate one on
     your Mac with `openssl rand -hex 24` and paste the output. You set it once
     here; compose uses it both to initialize the Postgres user and to build
     the bot's `DATABASE_URL` (`postgres://hylo:${DB_PASSWORD}@db:5432/hylo_support`).
   - To change/view it later: the same Environment tab (Dokploy stores it).
4. Deploy. First build takes a few minutes (npm ci + prisma engines).

### 3. Restore the database contents (no SSH needed)
The empty Postgres gets its schema automatically on boot (`migrate deploy`),
but the bot's data must come from the current machine — Asset rows (mints,
stake vaults, collateral wallets, cap, emoji), FAQs, venues, corrections.

Only the ESSENTIAL config tables are transferred (faqs, faq_categories,
venues, assets, venue_asset_xp, corrections — tiny). The large tables
(price_snapshots, mint_flow_events, search/audit logs) are deliberately
skipped: they regenerate as the bot runs, and the ticker's 24h change
bootstraps from implied prices until snapshots accumulate (~24h).

The paste payload is PG16-safe: all `SET` lines and pg_dump-18 `\restrict`
markers are stripped (PG18-only settings abort the whole transaction on
PG16), gzipped, and base64-encoded into ONE line so the web terminal cannot
mangle a multi-line paste. Restore is atomic via BEGIN/COMMIT.

**Prepare (on the Mac, regenerate at cutover for freshest data):**
```bash
cd ~/Hylo\ Asset\ Live\ Bot
pg_dump -h localhost -U mac --no-owner --data-only --inserts \
  --table=faqs --table=faq_categories --table=venues --table=assets \
  --table=venue_asset_xp --table=corrections hylo_support > essential-data.sql
grep -vE "^(SET |\\\\(restrict|unrestrict))" essential-data.sql | sed '/^BEGIN;$/d; /^COMMIT;$/d' > /tmp/e.sql
{ echo "BEGIN;"; cat /tmp/e.sql; echo "COMMIT;"; } > essential-data-final.sql
gzip -c essential-data-final.sql | base64 | tr -d '\n' | pbcopy
```
The payload (~20 KB, one line) is now on the clipboard.

**Restore (in Dokploy's UI):**
1. Compose deployment → **db** container → **Open Terminal** / Containers tab.
2. Paste this ONE line, replacing `<PASTE>` with the clipboard (Cmd-V):
   ```
   echo '<PASTE>' | base64 -d | gunzip > /tmp/r.sql && psql -U hylo -d hylo_support -f /tmp/r.sql
   ```
3. Expect 45 `INSERT 0 1` lines and a final `COMMIT`.
4. Verify: `psql -U hylo -d hylo_support -c 'SELECT symbol FROM assets;'`
   should list the 7 tracked assets.

(If the VPS ever regains SSH access, a full 1:1 dump works too:
`pg_dump --no-owner --no-privileges --clean --if-exists hylo_support > dump.sql`,
scp it up, and `docker exec -i <pg-container> psql -U hylo -d hylo_support < dump.sql`.)

### 4. Cutover — stop the Mac instance FIRST or immediately after
```bash
# on this Mac: stop the dev-mode bot (it runs in a terminal via npm run dev)
pkill -f "tsx/esm --watch src/index.ts"
```
If both run at once, alerts double-post and ticker nicknames fight — keep the
overlap under a minute.

### 5. Verify from Dokploy's logs
You want to see, in order:
- `All migrations have been successfully applied.` (boot migrations)
- `Starting Hylo Support Copilot` → `Database connection established`
- `Ticker bot online` ×4 (XSOL, XBTC, XHYPE, eHYUSD)
- `Mint watcher started` then `Hylo API feed checkpoint seeded — alerting from now`
- Within ~5 minutes: ticker nicknames updating in Discord, and (if anything
  happens on-chain) alerts posting via the feed path.

### 6. Smoke-test the new VPS's network position (once)
```bash
git clone <repo> && cd hylo-asset-live-bot
npm ci
HELIUS_API_KEY=<key> node --env-file=.env --import tsx/esm api-migration-tests/04-price-parity.ts
```
Confirms api.hylo.so + Helius are reachable and sane from the datacenter IP
(the API's bot-protection 503 was seen from a home connection; the client
backs off and retries either way).

## Ongoing

- **Deploys:** push to main → Dokploy rebuilds → migrations apply on boot.
  Downtime is one container restart; checkpoints re-seed without backfill
  (same as any restart has always been).
- **Rollback / kill switch:** Dokploy → redeploy previous image, or set
  `HYLO_V1_EVENTS_DISABLED=1` in env to force pure-RPC event scanning.
- **Do not** scale the bot service beyond 1 replica.
- Timezone doesn't matter: the daily summary schedules itself in UTC.
- Optionally back up the `db-data` volume (Dokploy's backup settings) — it
  holds the FAQ/venue content the support answers depend on.
