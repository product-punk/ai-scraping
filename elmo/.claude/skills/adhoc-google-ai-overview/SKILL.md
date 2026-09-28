---
name: adhoc-google-ai-overview
description: Run a new ad-hoc Google AI Overview scrape for a brand, with geo/location targeting. Collects the brand info Elmo needs (name, website, aliases, competitors), one or more prompts, and one or more locations, scrapes Google AI Overviews via DataForSEO per location, persists to the local Postgres (prompt_runs + citations), and writes a CSV. Use when the user says "adhoc google ai overview", "AI overview scrape", "google AIO", "check AI overview visibility", or wants location-specific Google AI Overview data for a brand. Unlike ChatGPT, this surface genuinely honors geo.
argument-hint: [brand, prompts, and locations]
---

Run an ad-hoc Google AI Overview scrape via `packages/lib/scripts/run-scrape.ts` (model `google-ai-overview`). Google's SERP surfaces genuinely localize by `location_code`, so this skill scrapes one run per (prompt × location). It upserts the brand/competitors/prompts, persists results the same way the worker does (`prompt_runs` + `citations`), and writes a combined CSV with a `location` column.

Any details the user gave are in `$ARGUMENTS`.

## 1. Preconditions (check, don't fix silently)

- Postgres must be reachable on `localhost:5432`. Check with `nc -z localhost 5432`. If it's down, start it (on macOS/Homebrew: `brew services start postgresql@16`).
- The `elmo` DB must be migrated. If a run errors that a relation (`prompt_runs`/`citations`) is missing, tell the user migrations are needed and STOP — per AGENTS.md, never run migrations without explicit instruction.
- Each (prompt × location) consumes DataForSEO credits (~$0.004). The script auto-loads the repo `.env`.

## 2. Collect inputs

Use whatever is in `$ARGUMENTS`; ask for anything missing in ONE message. Required: **brand name**, **website/domain**, **at least one prompt**, **at least one location**. Optional: **aliases** (comma-separated), **competitors** (each `Name:domain.com`), **language** (default `en`).

Locations are DataForSEO numeric `location_code`s. Accept country names from the user and map them to codes; ask for the code if unsure. Common ones:

| Location | code | | Location | code |
|----------|------|-|----------|------|
| United States | 2840 | | Germany | 2276 |
| United Kingdom | 2826 | | France | 2250 |
| Canada | 2124 | | India | 2356 |
| Australia | 2036 | | Spain | 2724 |

- A prompt must be ≤ 500 characters (the provider rejects longer).
- Total runs = prompts × locations. If that's 5+, echo the plan and confirm before spending credits.

## 3. Run the scrape

Make the output folder, then run the script once from `packages/lib`. Pass every prompt as a repeated `--prompt` and every location as a repeated `--location`. The script runs each prompt in each location, persists each as its own `prompt_run` + citations, and writes ONE combined CSV.

```bash
mkdir -p scrapes
cd packages/lib && pnpm exec tsx scripts/run-scrape.ts \
  --model google-ai-overview \
  --brand "<BRAND>" \
  --website "<DOMAIN>" \
  --prompt "<PROMPT 1>" \
  --prompt "<PROMPT 2>" \
  --location 2840 \
  --location 2826 \
  --language en \
  --aliases "<a,b>" \
  --competitor "<Name:domain.com>" \
  --csv "../../scrapes/<brand-slug>-aio.csv"
```

- `--model google-ai-overview` is required for this skill (that's what enables geo). To scrape Google AI Mode instead, use `--model google-ai-mode` — geo works there too.
- Omit `--aliases`/`--competitor` when none were given; repeat `--competitor` per competitor.
- The script retries once automatically on a transient DataForSEO error; a run that still fails is reported in the summary and the others continue.

## 4. Report

The script prints a per-run summary line (with the location) plus the single combined CSV path. Relay that back, note the `location` column lets them compare geos side by side, and mention where the CSV is so they can open it in Excel/Sheets.

Note: the AI Overview is generated on demand and isn't shown for every query/location — some runs may legitimately come back with little or no content. That's a real signal (no AIO for that geo), not a bug.
