# DESIGN.md: Client AI-Visibility Dashboard

Adapted from the WattVision monitoring-dashboard spec into a per-client template. The layout, surfaces and typography are fixed. **Brand colour and logo change for each client**, and come from the client's website.

## 1. Visual theme

- The dashboard should feel **reliable, technical and in control**: a simplified Power BI view a marketing lead can read in under a minute. It should not look like a social or consumer app.
- It uses a dark interface throughout, so the data stands out. It is meant for laptops and tablets, and still works at phone width.
- The client should recognise it as **theirs**: their logo sits top left, and their brand colour carries every key number and the main chart.

## 2. Colour system

### Fixed tokens (same for every client)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#121212` | Page background |
| `--card` | `#1E1E1E` | Card surfaces |
| `--line` | `#2C2C2E` | Card borders, table rules, chart grid |
| `--hover` | `#252525` | Table row hover |
| `--ink` | `#FFFFFF` | Primary text |
| `--muted` | `#98989D` | Labels, secondary text |
| `--good` / `--good-bg` | `#32D74B` / `#15301C` | Gains, "live" status |
| `--bad` / `--bad-bg` | `#FF453A` / `#3A1C1C` | Drops, lost prompts, competitor surges |

### Client tokens (set for each client from `clients.profile.branding`)

| Token | Source | Use |
|---|---|---|
| `--brand` | `branding.primary` | KPI bars, main chart line and area gradient, active tabs, "You" highlights, links, focus rings |
| `--brand-2` | `branding.accent` (falls back to a lighter `--brand`) | Secondary chart series (cited rate, citation share), citation bars |
| `--brand-soft` | `--brand` at 14% opacity | Selected rows, the client's own row in tables, active segment background |

**Readability rule:** a brand colour must reach at least **4.5:1 contrast against `--card`**. If it falls short, which is common with navy or dark-green brands, it is lightened step by step toward white until it passes. `applyTheme()` in `app.js` does this automatically. Never use a brand colour on the dark surface without this check.

**Where client colours come from:** `scripts/brand.ts` reads the client's homepage and stylesheets, in this order:
1. the `theme-color` meta tag
2. brand-named CSS variables (`--primary`, `--brand`, …)
3. the most frequent saturated colour

It ignores greys, near-white and near-black. If the colours look wrong, override them with `--primary "#hex" --accent "#hex"`. Always tell the client-facing teammate which hex codes were used.

## 3. Logo

- The client's square icon goes in a **56×56 tile with 16px radius**, top left, beside the client name. The tile background is white, so dark or transparent logos stay visible.
- Sources are tried in this order: `apple-touch-icon`, then SVG icon, then the largest PNG icon, then an `<img>` whose name or class contains "logo", then `favicon.ico`.
- If the site only offers a small raster icon (under 128px, the script warns), crop the mark out of the site's SVG logo and upload it with `brand.ts --icon-file mark.svg`. Scaler's 60px touch icon looked soft and cropped, so its mark was cut from the vector wordmark.
- The icon is stored in Supabase Storage (bucket `client-assets`, at `<client uuid>/icon.*`), never hotlinked. It is also used as the browser-tab favicon.
- If no icon is found, the tile shows the client's initials on `--brand`.
- Always look at the scraped icon before sharing the dashboard. Sites with bot protection can return a placeholder.

## 4. Components

- **Cards:** `border-radius: 16px`, background `--card`, padding `20px`, border `1px solid --line`.
- **KPI tiles:** label in `--muted` 13px, value in JetBrains Mono Bold 32px, a 4px progress bar in `--brand`, and a week-over-week delta: ▲ in `--good`, ▼ in `--bad`, ■ in `--muted`.
- **Charts:**
  - grid lines in `--line`, no axis borders
  - the main series is an **area chart** in `--brand` with a gradient fading to transparent
  - secondary series in `--brand-2`
  - competitors as thin dashed greys (`#8E8E93`, `#636366`)
  - percent axis labels in the mono font
- **Tables:**
  - rows separated by `1px solid --line`, hover background `--hover`
  - numbers right-aligned in the mono font
  - the client's row uses `--brand-soft` with a 3px `--brand` bar on the left
- **Alerts** (in the "This week" panel): `8px` radius and a `4px` left border.
  - **Bad:** `--bad-bg` background, `--bad` title
  - **Good:** `--good-bg` background, `--good` title
  - **Info:** dark blue background, `--brand` title
- **Pills:** `NAMED` / `CITED` in 11px mono, highlighted in `--brand` on `--brand-soft` when true, otherwise muted.
- **Tags:** "You" uses a `--brand` outline. Competitor names are muted. P1 is red, P2 is amber, and "Directional" (offerings with fewer than 3 prompts) is amber.
- **Sign-in screen:** a centred 420px card with username and password fields and the theme toggle. It keeps the default accent and shows no client name or logo, because the client isn't known until sign-in succeeds.
- **Header controls:** source switch, theme toggle (sun/moon) and sign out, as 38px icon buttons.

## 5. Typography

- **Titles:** Inter Semi Bold, 24px.
- **KPI numbers:** JetBrains Mono (Fira Code as fallback), Bold, 32px.
- **Body:** Inter Regular, 14px. **Labels:** 12–13px in `--muted`.

## 6. Layout

- **Shell:** a 248px left sidebar holds the client logo tile and name, then the tabs: **Overview · Prompts · Visibility · Citations · Fan-out · Insights**. Each tab has its own URL hash (`#citations`). Below 900px the sidebar becomes a top bar with a scrollable tab strip.
- **Top line of every tab:** the page title, with the **theme toggle ("Light mode" / "Dark mode") and sign out at the top right**. Keep them at the top; they are hard to find at the bottom of the sidebar.
- **Filter bar:**
  - Left: Latest scrape · Last 30 days · Last 90 days · All time · Custom range (from/to). Every period is compared with the previous period of the same length.
  - Right: model (All models / Live ChatGPT / OpenAI API), region (from the client's location code), and Filter (prompt intent, offering).
  - The selected range uses `--brand-soft` with a `--brand` outline. Pickers are outlined cards.
- **Overview:** the Profound-style split card (visibility score and trend chart with "Previous period" / "Compare competitors" toggles | visibility score rank with the client marked *Owned*), then the 4 KPI tiles, then What changed (alerts) next to share of voice.
- **Visibility:** scorecard by source, trend chart, you vs competitors, offering performance.
- **Citations:**
  - 4 KPIs: total citations, unique domains, citation share, citation SOV.
  - Category doughnut with the total in the centre and a "Top site per category" list under it, beside the category table. Clicking either filters the domain and page lists.
  - Top cited domains and most-cited pages.
- **Citation categories are per client:**
  - Universal ones are derived in the page: Your site, Competitor, Government, Institution, Platform.
  - Vertical ones come from `clients.profile.domain_categories` / `category_order`, written by the aeo-data-analysis skill through `save-insights.ts`.
  - Anything else shows as Unclassified, never guessed.
  - Each category gets a distinct colour: Your site = `--brand`, Competitor = `--bad`, Unclassified = grey.
- **Grid:** 12 columns with 8px-multiple gaps. Below 1100px cards stack. The page must never scroll sideways.

## 7. Metric definitions

These must stay identical to the aeo-data-analysis skill:

- **Visibility:** answers naming the brand ÷ answers.
- **Cited rate:** answers citing the brand's domain ÷ answers.
- **Share of voice:** brand mentions ÷ (brand + tracked competitor mentions).
- **Citation share:** brand-domain citations ÷ all citations.
- **Citation SOV:** brand citations ÷ (brand + tracked competitor citations).
- **Fan-out referral:** surfaced search results that the answer went on to cite.
- Headline visibility and SOV use **commercial** prompts. Branded and comparison prompts are reported separately.

## 8. Do's and don'ts

- ✅ **Do** use area charts for the main trend line.
- ✅ **Do** show the week-over-week change next to every headline number.
- ✅ **Do** put the client's own row first and highlight it in every comparison table.
- ✅ **Do** keep client wording plain: "named", "cited", "share of voice", with definitions in the footer.
- ❌ **Don't** use pastel colours or white backgrounds. The only white is the logo tile.
- ❌ **Don't** use a brand colour that fails the 4.5:1 check, or use brand colour for bad news. Drops are always `--bad`.
- ❌ **Don't** name the measurement tools (DataForSEO and so on) anywhere a client can see. Use "Live ChatGPT" and "OpenAI API".
- ❌ **Don't** use em or en dashes in client-facing copy. Use a colon or hyphen.
- ❌ **Don't** use generic stock icons. The client logo is the only image.
