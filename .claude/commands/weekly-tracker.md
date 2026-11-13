---
description: Weekly AI-visibility tracker — add/update a client, run a scrape now, list clients, pause/resume, or get a dashboard link (Supabase + Netlify; separate from the ad-hoc skills)
argument-hint: [add <client details> | run [slug] | insights <slug> | list | pause <slug> | resume <slug> | link <slug>]
---

Manage the **weekly tracker** in `weekly-tracker/` (repo root). It is deliberately separate from the ad-hoc skills (`/adhoc-chatgpt`, `/adhoc-google-ai-overview`): never edit or call `elmo/packages/lib/scripts/run-scrape.ts` from here, and never write tracker data to the local Elmo Postgres.

How it works: client setups (name, domain, prompts, competitors, country) live in the Supabase `clients` table. A GitHub Actions workflow (`.github/workflows/weekly-ai-visibility.yml`) runs every Monday 06:00 UTC, scrapes each active client's prompts (ChatGPT via DataForSEO + optionally the OpenAI API), and stores one timestamped **batch** per client in Supabase. Each client's Netlify dashboard (`<DASHBOARD_URL>/?c=<share_token>`) reads Supabase live, so it shows the new week as soon as the batch lands.

All commands run from the repo root with Node 24, no install needed. Credentials come from `weekly-tracker/.env` (see `.env.example`). If `.env` is missing or a key is empty, say which one and stop.

The repo is **public**: client JSON files under `weekly-tracker/clients/` are gitignored on purpose. Never commit them, never print service keys, and never paste a client's share token anywhere except back to the user.

User input: $ARGUMENTS

## add — add or update a client

1. Collect in ONE message whatever is missing: **brand name**, **domain**, **prompts** (each ≤ 500 chars), **country** (default US). Optional: aliases, competitors (`Name:domain`), language (default `en`), whether to include the OpenAI API comparison (default yes).
   - Country → DataForSEO `location_code`: US 2840, UK 2826, Canada 2124, Australia 2036, India 2356, Germany 2276, France 2250, Spain 2724. ChatGPT geo is country-level only.
   - If the user says to detect competitors from citations: run a one-off `node weekly-tracker/scripts/run-weekly.ts --client <slug>` after saving without competitors, then read the cited/search-result domains for that batch from Supabase, propose the insurers/vendors (exclude media, government, directories), and save again with them.
2. Write `weekly-tracker/clients/<slug>.json` (shape: `weekly-tracker/clients/example.json`). Slug = lowercase-hyphenated brand name. For competitor `aliases`, only add names specific enough not to match ordinary words (e.g. "Progressive Insurance", not "Progressive").
3. Save it: `node weekly-tracker/scripts/client.ts upsert weekly-tracker/clients/<slug>.json`. A new client gets a dashboard password automatically; it's printed once (only a bcrypt hash is stored). Give the user the link and the password, and tell them to send them to the client separately.
4. Brand the dashboard: `node weekly-tracker/scripts/brand.ts --client <slug> --dry-run`, then without `--dry-run`. It scrapes the site's icon (stored in Supabase Storage) and colours (stored in `profile.branding`). Download the icon URL it reports and look at it, and tell the user the hex codes picked. If the icon is wrong or the colours look off (or the site blocks scraping), re-run with `--icon <url>` and/or `--primary "#hex" --accent "#hex"`.
5. Tell the user the weekly cost: prompts × (~$0.004 ChatGPT + ~$0.01 OpenAI if enabled) per Monday.

## run — scrape now instead of waiting for Monday

- Preview first: `node weekly-tracker/scripts/run-weekly.ts [--client <slug>] --dry-run` and show the estimated cost. If it's more than ~$1, confirm before spending.
- Run in the cloud (preferred, same as Monday): `gh workflow run weekly-ai-visibility.yml -f client=<slug>` (blank = all). Then `gh run watch` or `gh run list --workflow weekly-ai-visibility.yml -L 1`.
- Or run locally: `node weekly-tracker/scripts/run-weekly.ts [--client <slug>]`.
- A manual run creates its own batch; the dashboard compares each batch with the one before it. Avoid several runs in the same week unless the user wants that.

## insights — weekly analysis with aeo-data-analysis → dashboard

Run after Monday's batch lands (check with `gh run list --workflow weekly-ai-visibility.yml -L 1`).

1. Export: `node weekly-tracker/scripts/export-batch.ts --client <slug>` (use `--weeks 6` when a trend is wanted). It writes `weekly-tracker/exports/<slug>/<date>/` with `-DataForSEO.csv`, `-OpenAI.csv`, `-Fan-Out.csv` (the skill's three input sheets, plus `run_date`, `brandCited`, `competitorsCited`) and `-context.json` (client profile, offerings, prompt tags, competitors, batch ids, previous weeks' metric snapshots).
2. Invoke the `aeo-data-analysis` skill on those files. Pre-fill its intake from `context.json` → `client.profile` / `competitors` / `prompt_tags` and ask the user to confirm in one line (the skill requires asking every run). If the profile is empty or the user changes an answer, update `weekly-tracker/clients/<slug>.json` (`profile`, `prompt_tags`) and re-run `client.ts upsert` so next week starts from it.
   - `brandMentioned` here = name in the answer prose; `brandCited` = the client's domain among sources. Use them as the skill's "named" and "cited".
   - Use `previous_snapshots` as the skill's Snapshots for trend tabs; compare like-for-like prompts only.
3. Besides the workbook, write `weekly-tracker/exports/<slug>/<date>/insights.json` in the shape documented at the top of `weekly-tracker/scripts/save-insights.ts`. Every number must come from the same computed data as the workbook (never estimated). `batch_id` / `previous_batch_id` come from `context.json`. Same style rules as the skill: no em/en dashes, no tool names, client-ready wording.
4. Save: `node weekly-tracker/scripts/save-insights.ts --client <slug> --file <insights.json>` (add `--draft` if the user wants to review before it shows on the dashboard; re-run without `--draft` to publish).
5. Report the headline, the top actions, and the workbook path.

## schedule: the Monday auto-scrape, with two switches (to control API cost)

1. **Global**: GitHub repo variable `WEEKLY_SCRAPE_ENABLED`. Unless it's `true`, Monday does nothing.
2. **Per client**: `clients.active`. A Monday run scrapes only clients switched on. **New clients start off.** Re-running `client.ts upsert` doesn't change the switch.

Both are **off** until the user says otherwise. Manual `run --client <slug>` scrapes a named client regardless of either switch.

- `schedule status`: show `gh variable get WEEKLY_SCRAPE_ENABLED --repo product-punk/ai-scraping`, `gh workflow list --repo product-punk/ai-scraping` (confirms the workflow exists on GitHub), `node weekly-tracker/scripts/client.ts list` (per-client `weekly=ON/off`), and `node weekly-tracker/scripts/run-weekly.ts --dry-run` (what next Monday would cost).
- `schedule on` / `schedule off`: `gh variable set WEEKLY_SCRAPE_ENABLED --body true|false --repo product-punk/ai-scraping`. Only turn it on when the user explicitly asks, and show the dry-run cost first.
- `weekly <slug> on|off`: `node weekly-tracker/scripts/client.ts weekly <slug> on|off`. Use this when a client starts or ends. Show the new Monday dry-run cost after switching one on.

## import: load an existing ad-hoc scrape as a dated batch

`node weekly-tracker/scripts/import-adhoc.ts --client <slug> --csv elmo/scrapes/<file>.csv --date YYYY-MM-DD [--dry-run]` reads the ad-hoc CSV and its `-search-results.csv` (read-only) and creates one batch on that date, recomputing named and cited with the tracker's rules. Check the run date with the user (file dates can mislead). Don't import the same file twice: it would count as a second week.

## list / pause / resume / link

- `node weekly-tracker/scripts/client.ts list` — all clients, active state, dashboard links.
- `node weekly-tracker/scripts/client.ts weekly <slug> on|off` (also `pause`/`resume`): switched-off clients are skipped on Mondays; history and dashboard are kept.
- `link`: run `list` and give back just that client's dashboard URL.
- `password <slug>`: `node weekly-tracker/scripts/client.ts password <slug>` issues a new random password (the old one stops working immediately). `password <slug> <new>` sets a specific one (10+ characters); `--clear` removes it, which leaves the dashboard open to anyone with the link, so confirm with the user first.

## Schema changes

Schema lives in `weekly-tracker/supabase/migrations/` (Supabase project `ai-visibility-tracker`, ref `mwqpyqkfwszrwwbuonxr`, already linked). Change it only by adding a new migration file, and only when the user asks for a schema change. Then, from `weekly-tracker/`, with `SUPABASE_DB_PASSWORD` exported from `.env`:

```bash
supabase db push --remote --dry-run   # check the target says ai-visibility-tracker
supabase db push --remote --yes
```

Always pass `--remote`: CLI v3 otherwise targets a local stack, and another project's local Supabase runs on this machine. There's no global `supabase` binary; use `/Users/mridulkathuria/Documents/dev/report-a-badmash/node_modules/.bin/supabase` (or install one).
