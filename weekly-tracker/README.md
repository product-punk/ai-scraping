# Weekly AI-visibility tracker

Every Monday, scrape each client's prompts in ChatGPT (via DataForSEO, country-targeted) and optionally the OpenAI API, store the results in Supabase with timestamps, and show them on a per-client Netlify dashboard that compares each week with the previous one.

This is separate from the ad-hoc skills (`/adhoc-chatgpt`, `/adhoc-google-ai-overview`), which keep writing to the local Elmo Postgres and Excel files. Day-to-day use goes through the `/weekly-tracker` command.

```
GitHub Actions (Mon 06:00 UTC) ─► scripts/run-weekly.ts ─► Supabase ─► Netlify dashboard (username + password)
```

## One-time setup

1. **Supabase schema.** Run these from `weekly-tracker/`:
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase db push --remote   # applies supabase/migrations/* (--remote: CLI v3 defaults to a local stack)
   ```
2. **Local env.** Copy `.env.example` to `.env` and fill it in.
3. **Add a client.**
   ```bash
   node scripts/client.ts upsert clients/<slug>.json
   ```
   This creates the client's first dashboard login and prints its username and password once.
4. **GitHub secrets.** In repo Settings → Secrets → Actions, add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` and `OPENAI_API_KEY`.
5. **Netlify.** Import the repo and set the base directory to `weekly-tracker`. Build settings come from `netlify.toml`. Set the env vars `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the publishable/anon key).

## Data model

- `clients` holds the setup: prompts, competitors, country, weekly on/off switch (`active`), branding.
- `dashboard_users` / `dashboard_sessions`: logins (bcrypt) tied to one client each, and 12-hour sessions (stored hashed).
- `batches` has one row per scrape of one client, such as each Monday. The dashboard compares the latest batch with the one before it.
- `runs` has one row per prompt × engine. It stores `brand_mentioned` (the name appears in the answer text), `brand_cited` (the client's site is a source), the competitor equivalents, and the full answer.
- `citations` and `search_results` hold sources and fan-out pages per run.
- `insights` has one row per analysed batch, written by the `aeo-data-analysis` skill through `/weekly-tracker insights <slug>`. It stores a headline, summary, metrics, findings, actions, competitor notes and outreach targets. `clients.profile` and `clients.prompt_tags` hold the skill's setup answers (business type, offerings, brand colours, each prompt's offering and intent) so the weekly analysis only asks you to confirm them.

Weekly loop: GitHub Actions scrapes on Monday, then you run `/weekly-tracker insights <slug>`, which exports, analyses, saves to Supabase, and updates the dashboard.

The tables are locked with row-level security. The browser can only call `dashboard_login`, `dashboard_logout`, `client_dashboard(session)` and `client_run_detail(session, run_id)`. Data comes back only for the signed-in user's client. Five wrong passwords lock a username for 15 minutes.

## Design

Dashboard look and per-client theming rules (brand colour, logo, layout, metric definitions): [`DESIGN.md`](DESIGN.md).

Commands also cover `scripts/brand.ts` (scrape a client's icon and colours) and `client.ts user add|reset|remove|list` (dashboard logins).

## Notes

- Client JSON files are gitignored because this repo is public. Supabase is the source of truth.
- GitHub turns off scheduled workflows in public repos after 60 days with no commits. If that happens, re-enable the workflow in the Actions tab.
- Free Supabase projects pause after a week of inactivity. The weekly write normally keeps the project active.
