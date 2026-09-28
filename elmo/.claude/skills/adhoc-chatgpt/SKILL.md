---
name: adhoc-chatgpt
description: Run a new ad-hoc ChatGPT AI-visibility scrape for a brand — collects the brand info Elmo needs (name, website, aliases, competitors) plus one or more prompts, scrapes ChatGPT via DataForSEO, persists to the local Postgres (prompt_runs + citations), and writes a CSV. Optionally also queries the OpenAI API for a scraped-vs-direct comparison. Use when the user says "adhoc chatgpt", "run a chatgpt scrape", "check chatgpt visibility", or wants ChatGPT AI-mention/citation data for a brand. ChatGPT has no geo — for location-specific results use adhoc-google-ai-overview.
argument-hint: [brand and/or prompt details]
---

Run an ad-hoc ChatGPT scrape via `packages/lib/scripts/run-scrape.ts` (model `chatgpt`). It takes one or more prompts, upserts the brand/competitors/prompts, persists results the same way the worker does (`prompt_runs` + `citations`), and writes a combined CSV. Everything accumulates under one brand so it hands off cleanly to the always-on worker later.

Any details the user gave are in `$ARGUMENTS`.

## 1. Preconditions (check, don't fix silently)

- Postgres must be reachable on `localhost:5432`. Check with `nc -z localhost 5432`. If it's down, start it (on macOS/Homebrew: `brew services start postgresql@16`).
- The `elmo` DB must be migrated. If a run errors that a relation (`prompt_runs`/`citations`) is missing, tell the user migrations are needed and STOP — per AGENTS.md, never run migrations without explicit instruction.
- Each prompt consumes DataForSEO credits (~$0.004); adding `--openai` also spends OpenAI credits (~$0.01/prompt). The script auto-loads the repo `.env`.

## 2. Collect inputs

Use whatever is in `$ARGUMENTS`; ask for anything missing in ONE message. Required: **brand name**, **website/domain**, **at least one prompt**. Optional: **aliases** (comma-separated), **competitors** (each `Name:domain.com`), and whether to **also query the OpenAI API** (`--openai`) for a scraped-vs-direct comparison.

- A prompt must be ≤ 500 characters (the provider rejects longer).
- ChatGPT is US-only here — do NOT offer geo/location (DataForSEO doesn't reliably honor it on the ChatGPT surface). If the user wants geo, point them to `adhoc-google-ai-overview`.
- If there are 5+ prompts, echo the plan and confirm before spending credits.

## 3. Run the scrape

Make the output folder, then run the script once from `packages/lib`. Pass every prompt as a repeated `--prompt` flag — the script loops over them, persists each as its own `prompt_run` + citations, and writes ONE combined CSV.

```bash
mkdir -p scrapes
cd packages/lib && pnpm exec tsx scripts/run-scrape.ts \
  --brand "<BRAND>" \
  --website "<DOMAIN>" \
  --prompt "<PROMPT 1>" \
  --prompt "<PROMPT 2>" \
  --aliases "<a,b>" \
  --competitor "<Name:domain.com>" \
  --csv "../../scrapes/<brand-slug>-chatgpt.csv"
```

- Omit `--aliases`/`--competitor` when none were given; repeat `--competitor` per competitor.
- Add `--openai` to also query the OpenAI API (gpt-5-mini) per prompt — each prompt then produces two runs, `provider=dataforseo` (scraped) and `provider=openai-api` (direct), distinguishable in the DB and the CSV `provider` column.
- The script retries once automatically on a transient `No response or tasks` DataForSEO hiccup; a run that still fails is reported in the summary and the others continue.

## 4. Report

The script prints a per-run summary line (provider, `prompt_run` id, brand mentioned, competitors mentioned, citation count) plus the single combined CSV path. Relay that back and mention where the CSV is so they can open it in Excel/Sheets.

`webQueries: ["unavailable"]` is expected, not an error — a search happened (citations prove it) but the provider didn't expose fan-out query strings.
