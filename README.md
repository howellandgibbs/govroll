# Govroll

It's Congress, finally readable.

Govroll is a civic transparency platform that makes legislation accessible to everyday people. Track bills, see how your representatives vote, and engage with the legislative process.

**Production:** [govroll.com](https://govroll.com)

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Database:** PostgreSQL via Prisma (with `@prisma/adapter-pg`)
- **Auth:** Supabase Auth
- **Hosting:** Vercel
- **AI:** OpenAI + Anthropic (bill chat)
- **Payments:** Stripe (donations)
- **Data Sources:** GovTrack API, Congress.gov API

## Local Development

### Prerequisites

- Node.js 20+
- Docker (for local PostgreSQL)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template and fill in your values
cp .env.example .env

# 3. Start local PostgreSQL
docker compose up -d

# 4. Run database migrations
npx prisma migrate deploy

# 5. Seed with sample data
npm run db:seed

# 6. Start dev server
npm run dev
```

The app runs at **http://localhost:1776**.

### Useful Commands

| Command                  | Description                                 |
| ------------------------ | ------------------------------------------- |
| `npm run dev`            | Start dev server on port 1776               |
| `npm run db:seed`        | Seed local DB with sample data              |
| `npm run db:reset`       | Reset DB and re-run all migrations          |
| `npm run db:studio`      | Open Prisma Studio (DB browser)             |
| `npm run lint`           | Run ESLint                                  |
| `npx prisma migrate dev` | Create a new migration after schema changes |

### Data Backfill Scripts

To populate your local DB with real data from legislative APIs:

```bash
npx tsx src/scripts/fetch-representatives.ts      # ~5s, no API key needed
npx tsx src/scripts/fetch-bills.ts                 # ~3min, no API key needed
npx tsx src/scripts/fetch-bill-text.ts --limit 20  # ~1min, needs CONGRESS_DOT_GOV_API_KEY
npx tsx src/scripts/fetch-bill-actions.ts          # ~2min, needs CONGRESS_DOT_GOV_API_KEY
npx tsx src/scripts/fetch-votes.ts                 # ~15min, no API key needed
```

## Environment Strategy

| File            | Committed | Purpose                                     |
| --------------- | --------- | ------------------------------------------- |
| `.env.example`  | Yes       | Template with placeholder values            |
| `.env`          | No        | Local dev config (copy from `.env.example`) |
| Vercel env vars | N/A       | Production secrets (set in dashboard)       |

There is no staging environment. All changes go directly from local dev to production via `main` branch pushes.

### Syncing Env Vars to Vercel

```bash
./scripts/setup-vercel-env.sh
```

This script reads your `.env` and upserts each variable into Vercel project settings. `NEXT_PUBLIC_*` vars go to all environments; secrets go to production only. `DATABASE_URL` is excluded (production uses a different database).

## Deployment

Push to `main` triggers an automatic Vercel deployment. The build runs:

```
prisma generate && next build
```

### Database migrations

Vercel builds **cannot reach** the prod Postgres on port 5432 (Supavisor
lives on 6543; direct connections from Vercel egress are blocked). The
build never runs `prisma migrate deploy`. So migrations apply manually
via the Supabase MCP in the agent loop:

```
mcp__supabase__apply_migration(name, query)
```

Then record the apply in the Prisma tracker so future tooling sees the
schema as in-sync:

```sql
INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
VALUES (gen_random_uuid()::text, '<sha256 of migration.sql>', NOW(), '<dir-name>', NOW(), 1);
```

CI guards this with the **Migration tracker drift** job
(`.github/workflows/ci.yml`) — every push and PR to `main` runs
`npm run db:migrate:check` against the prod tracker. The job fails if:

- A migration directory exists without a tracker row (forgot to apply)
- A tracker row exists without a directory (deleted-but-applied migration)
- Tracker checksum disagrees with `sha256(migration.sql)` (file edited
  post-apply, which Prisma forbids)

**One-time setup**: add `PROD_DATABASE_URL` to repo Secrets — Settings →
Secrets and variables → Actions. Use the Supavisor _direct_ connection
string (port 5432) so the read of `_prisma_migrations` doesn't go
through the pooler. Read-only credentials are sufficient.

This check existed because PR #55 (2026-04-27) shipped a migration that
was never applied — the thumbs-up/-down endpoint silently returned 500
for 3 days before anyone noticed. We never want to learn about a missed
migration from a user's broken click again.

### Ingestion (GitHub Actions)

Govroll runs on Vercel Hobby, which caps cron jobs at once-per-day. To get
fresher data (recorded floor votes in ~30 minutes, not ~24 hours), the
data pipeline is scheduled by **GitHub Actions** (`.github/workflows/ingest.yml`),
which calls idempotent, CRON_SECRET-gated endpoints on govroll.com.

| Endpoint                            | Cadence              | Purpose                                        |
| ----------------------------------- | -------------------- | ---------------------------------------------- |
| `/api/cron/compute-congress-status` | every 30 min         | In-session / recess / break detector           |
| `/api/cron/fetch-votes`             | hourly               | Recorded roll-call votes (cursor + 2d overlap) |
| `/api/cron/compute-momentum`        | hourly               | Recomputes alive/dormant/dead signal           |
| `/api/cron/backfill-bill-text`      | hourly               | Fills missing bill text (small batch)          |
| `/api/cron/backfill-bill-actions`   | hourly               | Status / action history for active bills       |
| `/api/cron/backfill-cosponsors`     | every 2h             | Individual cosponsor rows                      |
| `/api/cron/fetch-bills`             | every 3h             | New bills since our latest                     |
| `/api/cron/refresh-bill-metadata`   | hourly               | Sponsor / policyArea / CRS summary refresh     |
| `/api/cron/evaluate-budget`         | hourly               | Recomputes AI budget gate                      |
| `/api/cron/ingest-health`           | hourly               | Stall watchdog (pages on sustained stalls)     |
| `/api/cron/cleanup-expired-cache`   | daily 03:30 UTC      | Sweeps expired AiResponseCache rows            |
| `/api/cron/fetch-representatives`   | weekly Mon 10:00 UTC | Member roster refresh                          |
| `/api/cron/embed-large-bills`       | paused (manual)      | Chat RAG embeddings for large bills            |

The AI precompute crons (`generate-change-summaries`, `generate-bill-explainers`,
`generate-section-captions`) exist as endpoints but are not on any schedule —
manual-only since `937d70f` killed pre-launch precompute spend. AI for those
features now runs lazily on user action.

**One-time setup in the GitHub repo:**

1. `Settings → Secrets and variables → Actions → Secrets` — add `CRON_SECRET` matching the Vercel env var.
2. `Settings → Secrets and variables → Actions → Variables` — add `GOVROLL_BASE_URL` = `https://govroll.com` (no trailing slash).

**Manual trigger:** `Actions → ingest → Run workflow → pick endpoint`. Useful
for one-off backfills or forcing fresh data after a deploy.

`fetch-votes` also takes an optional `since` (YYYY-MM-DD) input for a deep
backfill — it walks day-by-day from that date and advances its `IngestCursor`
per day, so a backfill larger than one run's budget resumes on the next run
(the regular 30-min cron continues it until it catches up to the present).

**Why not Vercel cron?** Hobby allows 100 crons but only at daily minimum
interval (`0 */4 * * *` fails to deploy). GH Actions cron is free, supports
5-minute intervals, and has its own run history. If we upgrade to Vercel
Pro, we can move some of these back to Vercel cron for simpler operations.

## Architecture Notes

- **API routes** live in `src/app/api/`. Protected routes use `getAuthenticatedUserId()` from `src/lib/auth.ts`.
- **Admin endpoints** (`/api/admin/*`) require the `ADMIN_API_KEY` header.
- **AI chat** is budget-gated: if monthly AI spend exceeds donation income, chat is automatically disabled. See `src/lib/budget.ts` and `src/lib/ai-gate.ts`.
- **Bill data** flows: GovTrack (bills, votes, reps) + Congress.gov (text, actions, metadata). The daily cron keeps both in sync.
