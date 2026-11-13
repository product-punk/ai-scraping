// Client AI-visibility dashboard: tabbed (Overview / Prompts / Visibility / Citations /
// Fan-out / Insights) with a date-range, model, region and prompt filter bar.
//
// Metric definitions match the aeo-data-analysis skill so dashboard and Excel agree:
//   Visibility      = answers naming the brand / answers (run grain)
//   Cited rate      = answers citing the brand's domain / answers
//   SOV             = brand mentions / (brand + tracked competitor mentions)
//   Citation share  = brand-domain citations / all citations
//   Citation SOV    = brand citations / (brand + tracked competitor domain citations)
//   Fan-out referral= surfaced search results whose domain/URL the answer cited
// Citation categories: universal ones (own site, competitor, government, institution,
// platform) are detected here; vertical ones are per client (clients.profile
// domain_categories / category_order), written by the aeo-data-analysis skill.

const SOURCES = { "chatgpt-scraped": "Live ChatGPT", "openai-api": "OpenAI API" };
const MODELS = { all: "All models", "chatgpt-scraped": "Live ChatGPT", "openai-api": "OpenAI API" };
const RANGES = [["latest", "Latest scrape"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["all", "All time"]];
const REGIONS = { 2840: "United States", 2356: "India", 2826: "United Kingdom", 2124: "Canada", 2036: "Australia", 2276: "Germany", 2250: "France", 2724: "Spain" };
const TABS = [
	["overview", "Overview", '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
	["prompts", "Prompts", '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'],
	["visibility", "Visibility", '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
	["citations", "Citations", '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'],
	["fanout", "Fan-out", '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'],
	["insights", "Insights", '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>'],
];
const SESSION_KEY = "aeo-dash-session";
// Respect the OS "reduce motion" setting: charts render without their entry animation.
if (window.Chart && matchMedia("(prefers-reduced-motion: reduce)").matches) Chart.defaults.animation = false;

const S = { tab: "overview", range: "latest", from: null, to: null, model: "chatgpt-scraped", intent: "all", offering: "all", prevLine: false, compareComps: true, category: null };
let DATA = null, SESSION = null;
const charts = {};

// ---------- small utils ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const pct = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100));
const pctTxt = (x) => (pct(x) == null ? "-" : `${pct(x)}%`);
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const fmtShort = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const store = {
	get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
	set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
	del(k) { try { sessionStorage.removeItem(k); } catch {} },
};
const DAY = 86400000;
const muted = (s) => `<span style="color:var(--muted)">${s}</span>`;

// ---------- domains ----------
const TWO_LEVEL = new Set(["co.uk", "gov.uk", "ac.uk", "org.uk", "com.au", "net.au", "org.au", "gov.au", "edu.au", "com.sg", "gov.sg", "edu.sg", "co.in", "ac.in", "edu.in", "gov.in", "org.in", "net.in", "res.in", "nic.in", "co.nz", "govt.nz", "com.br", "gov.br", "co.jp", "ac.jp", "go.jp"]);
function baseDomain(d) {
	const parts = String(d || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const last2 = parts.slice(-2).join(".");
	return TWO_LEVEL.has(last2) ? parts.slice(-3).join(".") : last2;
}
function normUrl(u) {
	try {
		const x = new URL(u);
		for (const k of [...x.searchParams.keys()]) if (k.startsWith("utm_")) x.searchParams.delete(k);
		return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}${x.search}`.toLowerCase();
	} catch { return String(u || "").toLowerCase(); }
}

// ---------- theme ----------
function hexToRgb(h) {
	const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "").trim());
	return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
function lum([r, g, b]) {
	const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function readableOn(rgb, bg, min = 4.5) {
	const target = lum(bg) < 0.5 ? 255 : 0;
	let c = rgb.slice();
	for (let i = 0; i < 24 && contrast(c, bg) < min; i++) c = c.map((v) => v + (target - v) * 0.12);
	return c.map(Math.round);
}
const currentTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
function applyTheme(branding) {
	const card = currentTheme() === "light" ? [255, 255, 255] : [30, 30, 30];
	const root = document.documentElement.style;
	const p = hexToRgb(branding?.primary);
	if (!p) { for (const v of ["--brand", "--brand-2", "--brand-soft", "--on-brand"]) root.removeProperty(v); return; }
	const brand = readableOn(p, card);
	const second = hexToRgb(branding?.accent);
	const brand2 = second ? readableOn(second, card) : brand.map((v) => Math.round(v * 0.7 + (card[0] > 128 ? 0 : 255) * 0.3));
	root.setProperty("--brand", `rgb(${brand.join(",")})`);
	root.setProperty("--brand-2", `rgb(${brand2.join(",")})`);
	root.setProperty("--brand-soft", `rgba(${brand.join(",")},${card[0] > 128 ? 0.1 : 0.14})`);
	root.setProperty("--on-brand", contrast(brand, [255, 255, 255]) >= contrast(brand, [11, 11, 11]) ? "#ffffff" : "#0b0b0b");
}
const SUN = icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>');
const MOON = icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>');
const themeButton = (labelled = false) => {
	const next = currentTheme() === "dark" ? "light" : "dark";
	const label = next === "light" ? "Light mode" : "Dark mode";
	return `<button class="icon-btn${labelled ? " wide" : ""}" id="theme-toggle" type="button" aria-label="Switch to ${next} mode" title="Switch to ${next} mode">${next === "light" ? SUN : MOON}${labelled ? `<span>${label}</span>` : ""}</button>`;
};
function toggleTheme() {
	const next = currentTheme() === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	try { localStorage.setItem("aeo-dash-theme", next); } catch {}
	applyTheme(DATA?.client?.branding);
	if (DATA) return renderApp();
	const holder = document.createElement("span");
	holder.innerHTML = themeButton();
	document.getElementById("theme-toggle")?.replaceWith(holder.firstChild);
	document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
}

async function rpc(fn, body) {
	const cfg = window.TRACKER_CONFIG || {};
	const res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
		method: "POST",
		headers: { apikey: cfg.key, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
	return res.json();
}

// ---------- data indexes ----------
let CLIENT_DOMAIN = "", COMP_DOMAINS = new Map(), CITES_BY_RUN = new Map(), FANOUT_BY_RUN = new Map(), CAT_MAP = new Map(), CAT_ORDER = [];
function indexData() {
	CLIENT_DOMAIN = baseDomain(DATA.client.domain);
	COMP_DOMAINS = new Map();
	for (const c of DATA.client.competitors) for (const d of c.domains || []) COMP_DOMAINS.set(baseDomain(d), c.name);
	CITES_BY_RUN = new Map(); FANOUT_BY_RUN = new Map();
	for (const c of DATA.citations) (CITES_BY_RUN.get(c.run_id) || CITES_BY_RUN.set(c.run_id, []).get(c.run_id)).push(c);
	for (const s of DATA.fanout || []) (FANOUT_BY_RUN.get(s.run_id) || FANOUT_BY_RUN.set(s.run_id, []).get(s.run_id)).push(s);
	CAT_MAP = new Map(Object.entries(DATA.client.domain_categories || {}).map(([d, c]) => [baseDomain(d), c]));
	CAT_ORDER = Array.isArray(DATA.client.category_order) ? DATA.client.category_order : [];
}

// ---------- citation categories ----------
const PLATFORMS = new Set(["reddit.com", "quora.com", "youtube.com", "linkedin.com", "wikipedia.org", "medium.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "tiktok.com", "substack.com", "stackoverflow.com", "stackexchange.com", "github.com", "pinterest.com", "discord.com", "threads.net", "wikihow.com"]);
const FIXED_CATS = ["Your site", "Competitor"];
const TAIL_CATS = ["Government", "Institution", "Platform", "Unclassified"];
function categoryOf(domain) {
	const d = baseDomain(domain);
	const host = String(domain || "").toLowerCase();
	if (d === CLIENT_DOMAIN) return "Your site";
	if (COMP_DOMAINS.has(d)) return "Competitor";
	if (CAT_MAP.has(d)) return CAT_MAP.get(d);
	if (/\.(gov|mil)$|\.gov\.[a-z]{2}$|\.nic\.in$|\.gc\.ca$|europa\.eu$|\.govt\.nz$|\.go\.jp$/.test(host)) return "Government";
	if (/\.edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$/.test(host)) return "Institution";
	if (PLATFORMS.has(d)) return "Platform";
	return "Unclassified";
}
// Distinct hues for up to 16 categories; beyond that, golden-angle hues keep neighbours apart.
const CAT_COLORS = ["#5e9cff", "#f5a524", "#a78bfa", "#2dd4bf", "#f472b6", "#84cc16", "#fb7185", "#38bdf8", "#facc15", "#e879f9", "#4ade80", "#fb923c", "#94a3b8", "#22d3ee", "#c2410c", "#7c3aed"];
function categoryColor(cat, all) {
	if (cat === "Your site") return css("--brand");
	if (cat === "Competitor") return css("--bad");
	if (cat === "Unclassified") return css("--comp-2");
	const others = all.filter((c) => !["Your site", "Competitor", "Unclassified"].includes(c));
	const i = Math.max(0, others.indexOf(cat));
	return i < CAT_COLORS.length ? CAT_COLORS[i] : `hsl(${Math.round((i * 137.5) % 360)} 65% 60%)`;
}
function sortCategories(cats) {
	const rank = (c) => {
		if (FIXED_CATS.includes(c)) return FIXED_CATS.indexOf(c);
		if (CAT_ORDER.includes(c)) return 10 + CAT_ORDER.indexOf(c);
		if (TAIL_CATS.includes(c)) return 1000 + TAIL_CATS.indexOf(c);
		return 500;
	};
	return [...cats].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

// ---------- prompts / filters ----------
const tags = () => DATA.client.prompt_tags || {};
const intentOf = (p) => (tags()[p]?.intent || "").toLowerCase();
const isBranded = (p) => ["branded", "comparison", "branded/comparison"].includes(intentOf(p));
const hasIntentTags = () => DATA.client.prompts.some((p) => intentOf(p));
const isCommercial = (p) => (hasIntentTags() ? intentOf(p) === "commercial" : !isBranded(p));
function offeringOf(prompt) {
	const tagged = tags()[prompt]?.offering;
	if (tagged) return tagged;
	const lower = prompt.toLowerCase();
	const hits = (DATA.client.offerings || []).filter((o) => [o.name, ...(o.keywords || [])].some((k) => k && lower.includes(String(k).toLowerCase())));
	return hits.length === 1 ? hits[0].name : hits.length > 1 ? "Multiple" : "General";
}
const promptPasses = (p) =>
	(S.intent === "all" || (S.intent === "commercial" ? isCommercial(p) : S.intent === "branded" ? isBranded(p) : intentOf(p) === S.intent)) &&
	(S.offering === "all" || offeringOf(p) === S.offering);

// ---------- periods ----------
function periods() {
	const all = DATA.batches.slice().sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
	const inWin = (b, from, to) => { const t = new Date(b.started_at).getTime(); return t >= from && t < to; };
	if (S.range === "latest") {
		const cur = all.slice(-1), prev = all.length > 1 ? all.slice(-2, -1) : [];
		return { cur, prev, trend: all.slice(-12), label: cur[0] ? `Scrape of ${fmtDate(cur[0].started_at)}` : "", prevLabel: prev[0] ? `vs ${fmtDate(prev[0].started_at)}` : "" };
	}
	if (S.range === "all") return { cur: all, prev: [], trend: all, label: all.length ? `${fmtDate(all[0].started_at)} to ${fmtDate(all[all.length - 1].started_at)}` : "", prevLabel: "" };
	let from, to;
	if (S.range === "custom" && S.from && S.to) {
		from = new Date(`${S.from}T00:00:00`).getTime();
		to = new Date(`${S.to}T00:00:00`).getTime() + DAY;
	} else {
		to = Date.now() + 1;
		from = to - Number(S.range) * DAY;
	}
	const len = to - from;
	const cur = all.filter((b) => inWin(b, from, to));
	const prev = all.filter((b) => inWin(b, from - len, from));
	return { cur, prev, trend: cur, label: `${fmtDate(from)} to ${fmtDate(to - 1)}`, prevLabel: `vs ${fmtDate(from - len)} to ${fmtDate(from - 1)}` };
}
const runsOf = (batches, model = S.model) => {
	const ids = new Set(batches.map((b) => b.id));
	return DATA.runs.filter((r) => ids.has(r.batch_id) && (model === "all" || r.provider === model) && promptPasses(r.prompt));
};

// ---------- metrics ----------
const compNamed = (r, name) => r.competitors_mentioned.includes(name);
function metricsOf(runs) {
	const n = runs.length;
	if (!n) return null;
	const comps = DATA.client.competitors.map((c) => c.name);
	const brandMentions = runs.filter((r) => r.brand_mentioned).length;
	const compMentions = comps.reduce((acc, name) => acc + runs.filter((r) => compNamed(r, name)).length, 0);
	const cites = runs.flatMap((r) => CITES_BY_RUN.get(r.id) || []);
	const brandCites = cites.filter((c) => baseDomain(c.domain) === CLIENT_DOMAIN).length;
	const compCites = cites.filter((c) => COMP_DOMAINS.has(baseDomain(c.domain))).length;
	let surfaced = 0, referred = 0;
	for (const r of runs) {
		const fan = FANOUT_BY_RUN.get(r.id) || [];
		if (!fan.length) continue;
		const rc = CITES_BY_RUN.get(r.id) || [];
		const doms = new Set(rc.map((c) => baseDomain(c.domain)));
		const urls = new Set(rc.map((c) => normUrl(c.url)));
		for (const f of fan) { surfaced++; if (doms.has(baseDomain(f.domain)) || urls.has(normUrl(f.url))) referred++; }
	}
	return {
		n,
		visibility: brandMentions / n,
		citedRate: runs.filter((r) => r.brand_cited).length / n,
		sov: brandMentions + compMentions ? brandMentions / (brandMentions + compMentions) : 0,
		citationShare: cites.length ? brandCites / cites.length : null,
		citationSov: brandCites + compCites ? brandCites / (brandCites + compCites) : null,
		citations: cites.length,
		domains: new Set(cites.map((c) => baseDomain(c.domain))).size,
		referral: surfaced ? referred / surfaced : null,
		surfaced, referred,
	};
}
function entityRows(cur, prev) {
	const rate = (rs, f) => (rs.length ? rs.filter(f).length / rs.length : null);
	const rows = [{ name: DATA.client.name, domain: DATA.client.domain, me: true,
		v: rate(cur, (r) => r.brand_mentioned), pv: prev.length ? rate(prev, (r) => r.brand_mentioned) : null,
		cited: rate(cur, (r) => r.brand_cited), mentions: cur.filter((r) => r.brand_mentioned).length }];
	for (const c of DATA.client.competitors) {
		rows.push({ name: c.name, domain: (c.domains || [])[0], me: false,
			v: rate(cur, (r) => compNamed(r, c.name)), pv: prev.length ? rate(prev, (r) => compNamed(r, c.name)) : null,
			cited: rate(cur, (r) => r.competitors_cited.includes(c.name)), mentions: cur.filter((r) => compNamed(r, c.name)).length });
	}
	return rows.sort((a, b) => (b.v ?? 0) - (a.v ?? 0) || (b.cited ?? 0) - (a.cited ?? 0) || Number(b.me) - Number(a.me));
}

// ---------- UI atoms ----------
// Without a previous period the page says so once (period line); tiles and the rank
// list stay quiet, tables keep a "-" so their columns don't look broken.
function delta(cur, prev, { text = true, blank = false } = {}) {
	if (cur == null || prev == null) return text || blank ? "" : `<span class="delta flat">-</span>`;
	const d = pct(cur) - pct(prev);
	const cls = d === 0 ? "flat" : d > 0 ? "up" : "down";
	return `<span class="delta ${cls}">${d > 0 ? "+" : ""}${d}${text ? " pts" : "%"}</span>`;
}
function kpi(label, value, prev, note, cls = "c3") {
	const v = pct(value);
	return `<div class="card kpi ${cls}"><h3>${esc(label)}</h3><div class="val">${v ?? "-"}<span class="unit">%</span></div>
		<div class="bar2"><span style="width:${v ?? 0}%"></span></div>${delta(value, prev)}${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
}
const pill = (run) => run
	? `<span class="pill"><span class="${run.brand_mentioned ? "yes" : ""}">NAMED</span><span class="${run.brand_cited ? "yes" : ""}">CITED</span></span>`
	: muted("-");
function favicon(name, domain, me) {
	const b = DATA.client.branding || {};
	if (me && /^https:\/\//.test(b.icon_url || "")) return `<span class="fav"><img src="${esc(b.icon_url)}" alt=""></span>`;
	const init = esc(String(name).slice(0, 1).toUpperCase());
	if (!domain) return `<span class="fav">${init}</span>`;
	return `<span class="fav" data-init="${init}"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(baseDomain(domain))}&sz=64" alt=""></span>`;
}

// ---------- shell ----------
function shell(inner) {
	const { client } = DATA;
	const b = client.branding || {};
	const iconOk = /^https:\/\//.test(b.icon_url || "");
	const initials = client.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
	return `<div class="shell">
		<aside class="side">
			<div class="who">${iconOk ? `<div class="logo"><img src="${esc(b.icon_url)}" alt="${esc(client.name)} logo"></div>` : `<div class="logo initials">${esc(initials)}</div>`}
				<div style="min-width:0"><div class="name">${esc(client.name)}</div><div class="dom">${esc(client.domain)}</div></div></div>
			<nav class="tabs" aria-label="Sections">${TABS.map(([id, label, paths]) => `<a href="#${id}" ${S.tab === id ? 'aria-current="page"' : ""}>${icon(paths)}${label}</a>`).join("")}</nav>
		</aside>
		<main id="main">${inner}</main>
	</div>`;
}

function filterBar(title, P) {
	const offerings = [...new Set(DATA.client.prompts.map(offeringOf))];
	const intents = [...new Set(DATA.client.prompts.map(intentOf).filter(Boolean))];
	const locs = [...new Set(DATA.runs.map((r) => r.location_code).filter(Boolean))];
	const region = locs.length ? locs.map((l) => REGIONS[l] || `Location ${l}`).join(", ") : REGIONS[DATA.client.location_code] || "Default";
	const filtered = S.intent !== "all" || S.offering !== "all";
	const extraIntents = intents.filter((i) => !["commercial", "branded", "comparison"].includes(i)).map((i) => [i, i[0].toUpperCase() + i.slice(1)]);
	return `<div class="topline"><h1>${esc(title)}</h1><div class="top-actions">${themeButton(true)}<button class="icon-btn" id="logout" type="button" aria-label="Sign out" title="Sign out">${icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>')}</button></div></div>
	<div class="bar">
		<div class="ranges">
			${RANGES.map(([k, v]) => `<button type="button" data-range="${k}" class="${S.range === k ? "on" : ""}">${v}</button>`).join("")}
			<div class="dd"><button type="button" class="${S.range === "custom" ? "on" : ""}" data-menu="custom">Custom range ▾</button>
				<div class="menu left" id="menu-custom"><label for="f-from">From</label><input type="date" id="f-from" value="${esc(S.from || "")}">
					<label for="f-to">To</label><input type="date" id="f-to" value="${esc(S.to || "")}"><button class="apply" type="button" id="apply-custom">Apply</button></div></div>
		</div>
		<div class="pickers">
			<div class="dd"><button type="button" class="pickbtn" data-menu="model">${icon('<path d="M12 3l1.9 5.8L20 10l-5 3.6L16.5 20 12 16.5 7.5 20 9 13.6 4 10l6.1-1.2z"/>')}${esc(MODELS[S.model])}</button>
				<div class="menu" id="menu-model">${Object.entries(MODELS).map(([k, v]) => `<button class="opt ${S.model === k ? "on" : ""}" data-model="${k}" type="button">${v}</button>`).join("")}</div></div>
			<div class="dd"><button type="button" class="pickbtn" data-menu="region">${icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>')}${esc(region)}</button>
				<div class="menu" id="menu-region"><label>Region</label><div style="padding:4px 10px 8px">Live ChatGPT answers are scraped from <b>${esc(region)}</b>. OpenAI API answers have no location.</div></div></div>
			<div class="dd"><button type="button" class="pickbtn ${filtered ? "active" : ""}" data-menu="filter">${icon('<path d="M4 6h16M7 12h10M10 18h4"/>')}Filter${filtered ? " •" : ""}</button>
				<div class="menu" id="menu-filter">
					<label>Prompt intent</label>${[["all", "All prompts"], ["commercial", "Commercial"], ["branded", "Branded / comparison"], ...extraIntents]
						.map(([k, v]) => `<button class="opt ${S.intent === k ? "on" : ""}" data-intent="${esc(k)}" type="button">${esc(v)}</button>`).join("")}
					<label>Offering</label>${[["all", "All offerings"], ...offerings.map((o) => [o, o])].map(([k, v]) => `<button class="opt ${S.offering === k ? "on" : ""}" data-offering="${esc(k)}" type="button">${esc(v)}</button>`).join("")}
				</div></div>
		</div>
	</div>
	<div class="period">${esc(P.label)}${P.prev.length && P.prevLabel ? ` · ${esc(P.prevLabel)}` : ""}${!P.prev.length && S.range !== "all" ? " · No earlier scrape to compare yet" : ""}${filtered ? ` · filtered to ${esc([S.intent !== "all" ? S.intent : "", S.offering !== "all" ? S.offering : ""].filter(Boolean).join(", "))}` : ""}</div>`;
}

// ---------- tabs ----------
function computeAlerts(cur, prev) {
	const out = [];
	if (!prev.length) return [{ kind: "info", title: "No earlier period to compare", text: "Changes appear once there is a previous scrape in range." }];
	const key = (r) => `${r.prompt}|${r.provider}`;
	const prevBy = new Map(prev.map((r) => [key(r), r]));
	for (const r of cur) {
		const p = prevBy.get(key(r));
		if (!p) continue;
		const label = `${r.prompt.length > 70 ? `${r.prompt.slice(0, 70)}…` : r.prompt} (${SOURCES[r.provider]})`;
		if (p.brand_mentioned && !r.brand_mentioned) out.push({ kind: "bad", title: "No longer named", text: label });
		if (!p.brand_mentioned && r.brand_mentioned) out.push({ kind: "good", title: "Now named", text: label });
		if (p.brand_cited && !r.brand_cited) out.push({ kind: "bad", title: "Website no longer cited", text: label });
		if (!p.brand_cited && r.brand_cited) out.push({ kind: "good", title: "Website now cited", text: label });
	}
	for (const c of DATA.client.competitors) {
		const now = cur.filter((r) => compNamed(r, c.name)).length / cur.length;
		const before = prev.filter((r) => compNamed(r, c.name)).length / prev.length;
		if (now - before >= 0.25) out.push({ kind: "bad", title: `${c.name} gaining`, text: `Named in ${pct(now)}% of answers, up from ${pct(before)}%.` });
	}
	return out.length ? out : [{ kind: "info", title: "No major changes", text: "Every prompt held its result versus the previous period." }];
}

/** Visibility per source for the current period: real data for the space a trend chart would use. */
function bySource(P) {
	const rows = Object.keys(SOURCES).map((e) => ({ e, m: metricsOf(runsOf(P.cur, e)) })).filter((r) => r.m);
	if (rows.length < 2) return "";
	return `<div class="by-source"><h3>Visibility by source</h3>${rows.map(({ e, m }) => `<div class="bs-row"><span>${esc(SOURCES[e])}</span>
		<span class="bs-bar"><span style="width:${pct(m.visibility)}%"></span></span><span class="bs-v">${pctTxt(m.visibility)}</span></div>
		<div class="bs-sub">Named in ${Math.round(m.visibility * m.n)} of ${m.n} answers · website cited in ${pctTxt(m.citedRate)}</div>`).join("")}</div>`;
}

/** A one-point line chart reads as broken; say when the trend will exist instead. */
function trendEmpty(P) {
	const last = P.trend[P.trend.length - 1] || P.cur[P.cur.length - 1];
	// Only promise a date that's still ahead; weekly runs can be switched off.
	const nextTs = last ? new Date(last.started_at).getTime() + 7 * DAY : 0;
	const next = nextTs > Date.now() ? fmtDate(nextTs) : null;
	return `<div class="trend-empty">${icon('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>')}
		<div><b>${P.trend.length ? "Only one scrape in this view so far" : "No scrapes in this view"}</b>
		<p>The trend line appears once there are two or more scrapes${next && P.trend.length ? `, from the next weekly run (around ${esc(next)})` : ", starting with the next scrape"}. Try "All time" to include every scrape.</p></div></div>`;
}

function tabOverview(P, cur, prev) {
	const m = metricsOf(cur), pm = metricsOf(prev);
	const com = (rs) => rs.filter((r) => isCommercial(r.prompt));
	const mc = metricsOf(com(cur)), pmc = metricsOf(com(prev));
	const rows = entityRows(cur, prev);
	const myRank = rows.findIndex((r) => r.me) + 1;
	const insight = (DATA.insights || []).find((i) => P.cur.some((b) => b.id === i.batch_id));
	const alerts = computeAlerts(cur, prev);
	const totalMentions = Math.max(1, rows.reduce((a, x) => a + x.mentions, 0));
	return `
	<section class="sec"><h2>Visibility score</h2><p class="lead">How often your brand is named in AI-generated answers</p>
		<div class="split">
			<div>
				<div class="big">${pctTxt(m.visibility)} <span class="d">${delta(m.visibility, pm?.visibility, { text: false, blank: true })}</span></div>
				${P.trend.length < 2 ? trendEmpty(P) + bySource(P) : `<div class="chartbox"><canvas id="ch-vis" role="img" aria-label="Visibility over time"></canvas></div>
				<div class="toggles"><label><input type="checkbox" checked disabled> Current period</label>
					<label><input type="checkbox" id="tg-prev" ${S.prevLine ? "checked" : ""}> Previous period</label>
					<label><input type="checkbox" id="tg-comp" ${S.compareComps ? "checked" : ""}> Compare competitors</label></div>`}</div>
			<div><h3 style="font:500 14px var(--sans);color:var(--muted);margin:0">Visibility score rank</h3>
				<div class="big">#${myRank}</div>
				<ol class="rank">${rows.slice(0, 8).map((r, i) => `<li><span class="n">${i + 1}</span>${favicon(r.name, r.domain, r.me)}<span class="nm">${esc(r.name)}${r.me ? '<span class="owned">Owned</span>' : ""}</span><span class="v">${pctTxt(r.v)}</span><span class="dd2">${delta(r.v, r.pv, { text: false, blank: true })}</span></li>`).join("")}</ol></div>
		</div>
	</section>
	<section class="sec"><h2>Key metrics</h2><p class="lead">Headline figures for the selected period and filters</p>
		<div class="grid">
			${kpi("Visibility · commercial prompts", mc?.visibility ?? null, pmc?.visibility, hasIntentTags() ? `${mc?.n ?? 0} commercial answers` : "Prompts not tagged by intent yet")}
			${kpi("Visibility · all prompts", m.visibility, pm?.visibility)}
			${kpi("Share of voice · commercial", mc?.sov ?? null, pmc?.sov)}
			${kpi("Brand citation share", m.citationShare, pm?.citationShare, `${m.citations} citations`)}
		</div>
	</section>
	<section class="sec"><h2>What changed</h2><p class="lead">${esc(P.prevLabel ? `Compared ${P.prevLabel.replace(/^vs /, "with ")}` : "Compared with the previous period")}</p>
		<div class="grid top">
			<div class="card c7">${insight ? `<p class="headline">${esc(insight.headline)}</p>${insight.summary ? `<p class="summary">${esc(insight.summary)}</p>` : ""}` : ""}
				<div class="alerts">${alerts.slice(0, 8).map((a) => `<div class="alert ${a.kind}"><b>${esc(a.title)}</b>${esc(a.text)}</div>`).join("")}</div></div>
			<div class="card c5"><h3>Share of voice <small>mentions vs tracked competitors</small></h3>
				<table><tbody>${rows.map((r) => `<tr class="${r.me ? "me" : ""}"><td>${esc(r.name)}</td><td class="num"><span class="minibar"><span style="width:${(r.mentions / totalMentions) * 100}%"></span></span>${pctTxt(r.mentions / totalMentions)}</td></tr>`).join("")}</tbody></table></div>
		</div>
	</section>`;
}

function tabPrompts(P, cur, prev) {
	const order = new Map(DATA.client.prompts.map((q, i) => [q, i]));
	const prompts = [...new Set(cur.map((r) => r.prompt))].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
	const engines = S.model === "all" ? Object.keys(SOURCES) : [S.model];
	const prevBy = new Map(prev.map((r) => [`${r.prompt}|${r.provider}`, r]));
	const curBy = new Map(cur.map((r) => [`${r.prompt}|${r.provider}`, r]));
	return `<section class="sec"><h2>Prompts</h2><p class="lead">${prompts.length} prompts in this view. Click a row to read the full answer.</p>
	<div class="card"><div class="scroll"><table>
		<thead><tr><th class="num">#</th><th>Prompt</th><th>Offering · intent</th>${engines.map((e) => `<th>${esc(SOURCES[e])}</th><th>Previous</th>`).join("")}<th>Competitors named</th></tr></thead><tbody>
		${prompts.map((q) => {
			const comps = [...new Set(cur.filter((r) => r.prompt === q).flatMap((r) => r.competitors_mentioned))];
			return `<tr class="click prompt" tabindex="0" data-prompt="${esc(q)}"><td class="num">${(order.get(q) ?? 0) + 1}</td><td>${esc(q)}</td><td>${muted(`${esc(offeringOf(q))}${intentOf(q) ? ` · ${esc(intentOf(q))}` : ""}`)}</td>
				${engines.map((e) => `<td>${pill(curBy.get(`${q}|${e}`))}</td><td>${prev.length ? pill(prevBy.get(`${q}|${e}`)) : muted("-")}</td>`).join("")}
				<td>${muted(esc(comps.join(", ") || "-"))}</td></tr>`;
		}).join("") || `<tr><td colspan="8">${muted("No prompts match these filters.")}</td></tr>`}
	</tbody></table></div></div></section>`;
}

function tabVisibility(P, cur, prev) {
	const scoreRows = ["chatgpt-scraped", "openai-api", "all"].map((e) => {
		const rs = runsOf(P.cur, e);
		return { label: e === "all" ? "Combined" : MODELS[e], e, m: metricsOf(rs), mc: metricsOf(rs.filter((r) => isCommercial(r.prompt))) };
	}).filter((x) => x.m);
	const offerings = [...new Set(cur.map((r) => offeringOf(r.prompt)))].map((name) => {
		const rs = cur.filter((r) => offeringOf(r.prompt) === name && !isBranded(r.prompt));
		const m = metricsOf(rs);
		const top = DATA.client.competitors.map((c) => ({ name: c.name, n: rs.filter((r) => compNamed(r, c.name)).length })).sort((a, b) => b.n - a.n)[0];
		return { name, prompts: new Set(rs.map((r) => r.prompt)).size, m, top: top && top.n ? `${top.name} (${top.n})` : "-" };
	}).filter((o) => o.m).sort((a, b) => b.m.visibility - a.m.visibility);
	const rows = entityRows(cur, prev);
	const totalMentions = rows.reduce((a, r) => a + r.mentions, 0);
	const br = metricsOf(cur.filter((r) => isBranded(r.prompt)));
	return `
	<section class="sec"><h2>Scorecard by source</h2><p class="lead">Every metric for Live ChatGPT, the OpenAI API and both combined (commercial prompts in brackets)</p>
		<div class="card"><div class="scroll"><table>
			<thead><tr><th>Source</th><th class="num">Answers</th><th class="num">Visibility</th><th class="num">Cited rate</th><th class="num">Citation share</th><th class="num">Share of voice</th><th class="num">Citation SOV</th><th class="num">Fan-out referral</th></tr></thead><tbody>
			${scoreRows.map(({ label, e, m, mc }) => `<tr class="${e === S.model ? "me" : ""}"><td>${esc(label)}</td><td class="num">${m.n}</td>
				<td class="num">${pctTxt(m.visibility)} ${muted(`(${pctTxt(mc?.visibility)})`)}</td><td class="num">${pctTxt(m.citedRate)}</td>
				<td class="num">${pctTxt(m.citationShare)}</td><td class="num">${pctTxt(m.sov)} ${muted(`(${pctTxt(mc?.sov)})`)}</td>
				<td class="num">${pctTxt(m.citationSov)}</td><td class="num">${m.surfaced ? `${pctTxt(m.referral)} ${muted(`${m.referred}/${m.surfaced}`)}` : "-"}</td></tr>`).join("")}
		</tbody></table></div>${br ? `<div class="note">Branded and comparison prompts (${br.n} answers) are kept out of commercial figures. Their visibility: ${pctTxt(br.visibility)}.</div>` : ""}</div>
	</section>
	<section class="sec"><h2>Visibility over time</h2><p class="lead">Visibility, cited rate and citation share per scrape</p>
		<div class="card">${P.trend.length < 2 ? trendEmpty(P) : `<div class="chartbox"><canvas id="ch-vis2" role="img" aria-label="Visibility metrics over time"></canvas></div>`}</div></section>
	<section class="sec"><h2>You vs competitors</h2><p class="lead">Named, cited and share of mentions for tracked competitors</p>
		<div class="card"><div class="scroll"><table>
			<thead><tr><th>Company</th><th class="num">Named</th><th class="num">Change</th><th class="num">Cited</th><th class="num">Share of voice</th></tr></thead><tbody>
			${rows.map((r) => `<tr class="${r.me ? "me" : ""}"><td>${esc(r.name)}${r.me ? '<span class="tag me">You</span>' : ""}</td>
				<td class="num"><span class="minibar"><span style="width:${pct(r.v) ?? 0}%"></span></span>${pctTxt(r.v)}</td><td class="num">${delta(r.v, r.pv, { text: false })}</td>
				<td class="num">${pctTxt(r.cited)}</td><td class="num">${totalMentions ? pctTxt(r.mentions / totalMentions) : "-"}</td></tr>`).join("")}
		</tbody></table></div>${rows.filter((r) => !r.me).every((r) => !r.mentions) ? `<div class="note">No tracked competitor is named in this period. See the Citations tab for who AI engines cite instead, and consider tracking them.</div>` : ""}</div></section>
	<section class="sec"><h2>Offering performance</h2><p class="lead">Non-branded prompts per offering, strongest to weakest</p>
		<div class="card"><div class="scroll"><table>
			<thead><tr><th>Offering</th><th class="num">Prompts</th><th class="num">Visibility</th><th class="num">Cited rate</th><th class="num">Citation share</th><th class="num">SOV</th><th>Top competitor</th></tr></thead><tbody>
			${offerings.map((o) => `<tr><td>${esc(o.name)}${o.prompts < 3 ? '<span class="tag dir" title="Fewer than 3 prompts">Directional</span>' : ""}</td><td class="num">${o.prompts}</td><td class="num">${pctTxt(o.m.visibility)}</td><td class="num">${pctTxt(o.m.citedRate)}</td><td class="num">${pctTxt(o.m.citationShare)}</td><td class="num">${pctTxt(o.m.sov)}</td><td>${esc(o.top)}</td></tr>`).join("") || `<tr><td colspan="7">${muted("No offerings yet.")}</td></tr>`}
		</tbody></table></div></div></section>`;
}

// Citations-tab state kept between in-place category selections (no full re-render).
let CAT_CTX = null;

function catListsHtml() {
	const { cites, dc, pdc, prev, allCats } = CAT_CTX;
	const shown = [...dc.entries()].filter(([d]) => !S.category || categoryOf(d) === S.category).sort((a, b) => b[1] - a[1]).slice(0, 25);
	const maxN = shown[0]?.[1] || 1;
	const urlCount = cites.filter((c) => !S.category || categoryOf(c.domain) === S.category).reduce((acc, c) => { const e = acc.get(c.url) || { url: c.url, title: c.title, domain: c.domain, n: 0 }; e.n++; acc.set(c.url, e); return acc; }, new Map());
	const topUrls = [...urlCount.values()].sort((a, b) => b.n - a.n).slice(0, 12);
	return `<h2>Top cited domains${S.category ? ` · ${esc(S.category)} <button type="button" class="tag" id="clear-cat" style="cursor:pointer;background:none">clear ✕</button>` : ""}</h2><p class="lead">Ranked by citations in the selected period</p>
		<div class="grid">
			<div class="card c7"><div class="scroll"><table>
				<thead><tr><th>Domain</th><th>Category</th><th class="num">Citations</th><th class="num">Previous</th></tr></thead><tbody>
				${shown.map(([d, n]) => `<tr class="${d === CLIENT_DOMAIN ? "me" : ""}"><td>${esc(d)}</td><td>${muted(esc(categoryOf(d)))}</td><td class="num"><span class="minibar"><span style="width:${(n / maxN) * 100}%;background:${categoryColor(categoryOf(d), allCats)}"></span></span>${n}</td><td class="num">${prev.length ? pdc.get(d) || 0 : "-"}</td></tr>`).join("") || `<tr><td colspan="4">${muted("No citations.")}</td></tr>`}
			</tbody></table></div></div>
			<div class="card c5"><h3>Most-cited pages</h3><div class="scroll"><table><tbody>
				${topUrls.map((u) => `<tr><td><a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer">${esc(u.title || u.url.replace(/^https?:\/\//, "").slice(0, 70))}</a><div style="color:var(--muted);font-size:12px">${esc(baseDomain(u.domain))}</div></td><td class="num">${u.n}</td></tr>`).join("")}
			</tbody></table></div></div>
		</div>`;
}

function donutCenterHtml() {
	const { cites, cats } = CAT_CTX;
	if (!S.category) return `<div class="n">${cites.length}</div><div class="l">citations</div>`;
	const n = cats.get(S.category) || 0;
	return `<div class="n">${n}</div><div class="l">${esc(S.category)}<br>${pctTxt(cites.length ? n / cites.length : 0)} of citations</div>`;
}

function tabCitations(P, cur, prev) {
	const m = metricsOf(cur), pm = metricsOf(prev);
	const cites = cur.flatMap((r) => CITES_BY_RUN.get(r.id) || []);
	const pcites = prev.flatMap((r) => CITES_BY_RUN.get(r.id) || []);
	const byCat = (list) => list.reduce((acc, c) => { const k = categoryOf(c.domain); acc.set(k, (acc.get(k) || 0) + 1); return acc; }, new Map());
	const cats = byCat(cites), pcats = byCat(pcites);
	const allCats = sortCategories([...new Set([...cats.keys(), ...pcats.keys()])]);
	if (S.category && !cats.has(S.category)) S.category = null;
	const catRows = allCats.map((c) => ({ c, n: cats.get(c) || 0, share: cites.length ? (cats.get(c) || 0) / cites.length : 0,
		pshare: pcites.length ? (pcats.get(c) || 0) / pcites.length : null, domains: new Set(cites.filter((x) => categoryOf(x.domain) === c).map((x) => baseDomain(x.domain))).size }))
		.filter((r) => r.n || r.pshare);
	const domCount = (list) => list.reduce((acc, c) => acc.set(baseDomain(c.domain), (acc.get(baseDomain(c.domain)) || 0) + 1), new Map());
	const dc = domCount(cites), pdc = domCount(pcites);
	CAT_CTX = { cites, cats, dc, pdc, prev, allCats };
	const unclassified = catRows.find((r) => r.c === "Unclassified");
	// Most-cited domain in each category (skip the client's own site), biggest categories first.
	const leaders = catRows.filter((r) => r.n && r.c !== "Your site" && r.c !== "Unclassified").map((r) => {
		const top = [...dc.entries()].filter(([d]) => categoryOf(d) === r.c).sort((a, b) => b[1] - a[1])[0];
		return top ? { c: r.c, d: top[0], n: top[1], total: r.n } : null;
	}).filter(Boolean).sort((a, b) => b.total - a.total).slice(0, 8);
	const kpiNum = (label, v, pv) => `<div class="card kpi c3"><h3>${esc(label)}</h3><div class="val">${v ?? "-"}</div>${pv == null ? "" : `<span class="delta ${v - pv > 0 ? "up" : v - pv < 0 ? "down" : "flat"}">${v - pv > 0 ? "+" : ""}${v - pv} vs previous</span>`}</div>`;
	return `
	<section class="sec"><h2>Citations</h2><p class="lead">The sources AI engines read and link to when they answer your prompts</p>
		<div class="grid">
			${kpiNum("Total citations", m.citations, pm?.citations ?? null)}
			${kpiNum("Unique domains", m.domains, pm?.domains ?? null)}
			${kpi("Brand citation share", m.citationShare, pm?.citationShare)}
			${kpi("Citation share of voice", m.citationSov, pm?.citationSov, "Your citations vs tracked competitors'")}
		</div></section>
	<section class="sec"><h2>Citation categories</h2><p class="lead">What kind of site gets cited. Click a category to highlight it and filter the lists below.</p>
		<div class="grid">
			<div class="card c5 catcard"><div class="chartbox short"><canvas id="ch-cat" role="img" aria-label="Citations by category"></canvas>
				<div class="donut-center" id="donut-center">${donutCenterHtml()}</div></div>
				<h3 style="margin-top:20px">Top site per category</h3>
				<table class="tight"><tbody>${leaders.map((r) => `<tr class="click cat ${S.category === r.c ? "sel" : ""}" tabindex="0" data-cat="${esc(r.c)}"><td><span class="swatch" style="background:${categoryColor(r.c, allCats)}"></span>${esc(r.d)}<div class="sub2">${esc(r.c)}</div></td><td class="num">${r.n}</td></tr>`).join("")}</tbody></table></div>
			<div class="card c7"><div class="scroll"><table>
				<thead><tr><th>Category</th><th class="num">Citations</th><th class="num">Share</th><th class="num">Change</th><th class="num">Domains</th></tr></thead><tbody>
				${catRows.map((r) => `<tr class="click cat ${S.category === r.c ? "sel" : ""}" tabindex="0" data-cat="${esc(r.c)}"><td><span class="swatch" style="background:${categoryColor(r.c, allCats)}"></span>${esc(r.c)}</td><td class="num">${r.n}</td><td class="num">${pctTxt(r.share)}</td><td class="num">${delta(r.share, r.pshare, { text: false })}</td><td class="num">${r.domains}</td></tr>`).join("")}
			</tbody></table></div>${unclassified ? `<div class="note">${unclassified.domains} domain${unclassified.domains === 1 ? " is" : "s are"} not categorised yet. Categories for this client are set during the weekly analysis.</div>` : ""}</div>
		</div></section>
	<section class="sec" id="cat-lists">${catListsHtml()}</section>`;
}

/** Category selection updates in place: highlight the slice, sync rows, refresh only the lists. */
function selectCategory(cat) {
	S.category = cat && S.category !== cat ? cat : null;
	document.querySelectorAll("tr.cat").forEach((tr) => tr.classList.toggle("sel", tr.dataset.cat === S.category));
	const center = document.getElementById("donut-center");
	if (center) center.innerHTML = donutCenterHtml();
	const lists = document.getElementById("cat-lists");
	if (lists) {
		lists.innerHTML = catListsHtml();
		document.getElementById("clear-cat")?.addEventListener("click", () => selectCategory(null));
	}
	highlightDonut();
}

function withAlpha(color, a) {
	const c = String(color).trim();
	if (c.startsWith("#") && c.length === 7) return `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;
	if (c.startsWith("rgb(")) return c.replace("rgb(", "rgba(").replace(")", `,${a})`);
	if (c.startsWith("hsl(")) return c.replace(")", ` / ${a})`);
	return c;
}

function highlightDonut() {
	const chart = charts.cat;
	if (!chart) return;
	const ds = chart.data.datasets[0];
	const base = chart.$baseColors;
	ds.backgroundColor = chart.data.labels.map((l, i) => (!S.category || l === S.category ? base[i] : withAlpha(base[i], 0.18)));
	ds.offset = chart.data.labels.map((l) => (l === S.category ? 12 : 0));
	ds.borderWidth = chart.data.labels.map((l) => (l === S.category ? 0 : 2));
	chart.update();
}

function tabFanout(P, cur) {
	const m = metricsOf(cur);
	if (!m.surfaced) return `<section class="sec"><h2>Fan-out</h2><p class="lead">The web searches Live ChatGPT ran before answering</p><div class="card empty">No fan-out data for this selection. The OpenAI API doesn't expose surfaced results; switch the model to Live ChatGPT or All models.</div></section>`;
	const surfacedNotCited = new Map(), surfacedAll = new Map();
	for (const r of cur) {
		const citedDomains = new Set((CITES_BY_RUN.get(r.id) || []).map((c) => baseDomain(c.domain)));
		for (const f of FANOUT_BY_RUN.get(r.id) || []) {
			const d = baseDomain(f.domain);
			if (!d) continue;
			surfacedAll.set(d, (surfacedAll.get(d) || 0) + 1);
			if (!citedDomains.has(d)) surfacedNotCited.set(d, (surfacedNotCited.get(d) || 0) + 1);
		}
	}
	const youSurfaced = surfacedAll.get(CLIENT_DOMAIN) || 0;
	const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
	const row = ([d, n]) => `<tr class="${d === CLIENT_DOMAIN ? "me" : ""}"><td>${esc(d)}</td><td>${muted(esc(categoryOf(d)))}</td><td class="num">${n}</td></tr>`;
	return `<section class="sec"><h2>Fan-out</h2><p class="lead">The pages Live ChatGPT's searches surfaced, and how many it went on to cite</p>
		<div class="grid">
			<div class="card kpi c4"><h3>Results surfaced</h3><div class="val">${m.surfaced}</div></div>
			<div class="card kpi c4"><h3>Fan-out referral</h3><div class="val">${pct(m.referral)}<span class="unit">%</span></div><div class="note">${m.referred} of ${m.surfaced} surfaced results were cited</div></div>
			<div class="card kpi c4"><h3>Your site surfaced</h3><div class="val">${youSurfaced}<span class="unit">×</span></div><div class="note">${youSurfaced ? "Appeared in search results" : "Not surfaced in this period"}</div></div>
		</div></section>
	<section class="sec"><div class="grid">
		<div class="card c6"><h3>Most surfaced domains</h3><div class="scroll"><table><thead><tr><th>Domain</th><th>Category</th><th class="num">Times</th></tr></thead><tbody>${top(surfacedAll).map(row).join("")}</tbody></table></div></div>
		<div class="card c6"><h3>Surfaced but never cited</h3><div class="scroll"><table><thead><tr><th>Domain</th><th>Category</th><th class="num">Times</th></tr></thead><tbody>${top(surfacedNotCited).map(row).join("")}</tbody></table></div>
			<div class="note">Pages the search found but the answer passed over. A stronger page on these topics could win the citation.</div></div>
	</div></section>`;
}

function tabInsights(P) {
	const inPeriod = (DATA.insights || []).filter((i) => P.cur.some((b) => b.id === i.batch_id));
	if (!inPeriod.length) return `<section class="sec"><h2>Insights</h2><p class="lead">Analysis written for each weekly scrape</p><div class="card insight-empty">${icon('<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>')}
		<div><b>This period's analysis isn't published yet</b>
		<p>After each weekly scrape is reviewed, this tab shows the headline for the week, key findings, priority actions, notes on competitors and the sites worth reaching out to.${(DATA.insights || []).length ? ' Earlier analyses are available under "All time".' : ""}</p>
		<a class="btn" href="#overview">See this period's numbers on Overview</a></div></div></section>`;
	const i = inPeriod[0], c = i.content || {};
	return `<section class="sec"><h2>Insights</h2><p class="lead">Analysis of the scrape on ${fmtDate((DATA.batches.find((b) => b.id === i.batch_id) || {}).started_at || i.created_at)}</p>
		<div class="card" style="margin-bottom:16px"><p class="headline">${esc(i.headline)}</p>${i.summary ? `<p class="summary" style="margin:0">${esc(i.summary)}</p>` : ""}</div>
		<div class="grid">
			${(c.findings || []).length ? `<div class="card c6"><h3>Findings</h3><ul class="plain">${c.findings.map((f) => `<li>${esc(typeof f === "string" ? f : f.text || "")}</li>`).join("")}</ul></div>` : ""}
			${(c.actions || []).length ? `<div class="card c6"><h3>Priority actions</h3><ol class="actions">${c.actions.map((a) => `<li><b>${esc(a.title)}</b><span>${esc(a.detail || "")}</span></li>`).join("")}</ol></div>` : ""}
			${(c.competitors || []).length ? `<div class="card c12"><h3>Competitors</h3><ul class="plain">${c.competitors.map((x) => `<li><b>${esc(x.name)}</b>: ${esc(x.note || "")}</li>`).join("")}</ul></div>` : ""}
			${(c.outreach || []).length ? `<div class="card c12"><h3>Outreach targets</h3><div class="scroll"><table><thead><tr><th>Site</th><th>Tier</th><th>Page cited</th><th>Angle</th></tr></thead><tbody>
				${c.outreach.slice(0, 20).map((o) => `<tr><td>${esc(o.domain)}</td><td>${o.tier ? `<span class="tag ${esc(String(o.tier).toLowerCase())}">${esc(o.tier)}</span>` : ""}</td><td>${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.url.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : ""}</td><td>${muted(esc(o.angle || o.gap || ""))}</td></tr>`).join("")}
			</tbody></table></div></div>` : ""}
		</div></section>`;
}

const FOOT = `<div class="foot"><b>Visibility</b>: share of answers that name the company. <b>Cited rate</b>: share of answers citing its website. <b>Share of voice</b>: its mentions ÷ its plus tracked competitors' mentions. <b>Citation share</b>: its website's citations ÷ all citations. <b>Citation SOV</b>: its citations ÷ its plus tracked competitors' citations. <b>Fan-out referral</b>: surfaced search results the answer went on to cite. One run per prompt and source per scrape; answers vary run to run, so read trends across several weeks.</div>`;

// ---------- render ----------
function renderApp() {
	for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
	const P = periods();
	const cur = runsOf(P.cur), prev = runsOf(P.prev);
	const title = TABS.find(([id]) => id === S.tab)?.[1] || "Overview";
	let body;
	if (!cur.length) body = `<div class="card empty">No answers match this period and filters. Try "All time" or another model.</div>`;
	else if (S.tab === "prompts") body = tabPrompts(P, cur, prev);
	else if (S.tab === "visibility") body = tabVisibility(P, cur, prev);
	else if (S.tab === "citations") body = tabCitations(P, cur, prev);
	else if (S.tab === "fanout") body = tabFanout(P, cur);
	else if (S.tab === "insights") body = tabInsights(P);
	else body = tabOverview(P, cur, prev);
	// A first section titled like the page itself ("Citations" under "Citations") only stutters.
	body = body.replace(`<section class="sec"><h2>${title}</h2>`, '<section class="sec">');
	document.getElementById("app").innerHTML = shell(filterBar(title, P) + body + FOOT);
	bind(P);
	if (cur.length) drawCharts(P, cur, prev);
}

function bind(P) {
	const $ = (s) => document.querySelectorAll(s);
	document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
	document.getElementById("logout")?.addEventListener("click", logout);
	$(".fav img").forEach((img) => img.addEventListener("error", () => { img.parentElement.textContent = img.parentElement.dataset.init || ""; }));
	$("[data-range]").forEach((b) => b.addEventListener("click", () => { S.range = b.dataset.range; renderApp(); }));
	$("[data-menu]").forEach((b) => b.addEventListener("click", (e) => {
		e.stopPropagation();
		const menu = document.getElementById(`menu-${b.dataset.menu}`);
		const open = menu.classList.contains("open");
		document.querySelectorAll(".menu.open").forEach((x) => x.classList.remove("open"));
		if (!open) menu.classList.add("open");
	}));
	$(".menu").forEach((m) => m.addEventListener("click", (e) => e.stopPropagation()));
	$("[data-model]").forEach((b) => b.addEventListener("click", () => { S.model = b.dataset.model; renderApp(); }));
	$("[data-intent]").forEach((b) => b.addEventListener("click", () => { S.intent = b.dataset.intent; renderApp(); }));
	$("[data-offering]").forEach((b) => b.addEventListener("click", () => { S.offering = b.dataset.offering; renderApp(); }));
	document.getElementById("apply-custom")?.addEventListener("click", () => {
		const f = document.getElementById("f-from").value, t = document.getElementById("f-to").value;
		if (!f || !t || f > t) return;
		Object.assign(S, { range: "custom", from: f, to: t });
		renderApp();
	});
	document.getElementById("tg-prev")?.addEventListener("change", (e) => { S.prevLine = e.target.checked; renderApp(); });
	document.getElementById("tg-comp")?.addEventListener("change", (e) => { S.compareComps = e.target.checked; renderApp(); });
	$("tr.cat").forEach((tr) => {
		const go = () => selectCategory(tr.dataset.cat);
		tr.addEventListener("click", go);
		tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
	});
	document.getElementById("clear-cat")?.addEventListener("click", () => selectCategory(null));
	$("tr.prompt").forEach((tr) => {
		const open = () => openPrompt(tr.dataset.prompt, runsOf(P.cur));
		tr.addEventListener("click", open);
		tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
	});
}
document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")); });
window.addEventListener("hashchange", () => {
	const t = location.hash.slice(1);
	if (TABS.some(([id]) => id === t)) { S.tab = t; if (DATA) { renderApp(); window.scrollTo(0, 0); } }
});

// ---------- charts ----------
function baseOpts() {
	const grid = css("--line"), mutedC = css("--muted");
	return {
		maintainAspectRatio: false,
		interaction: { mode: "index", intersect: false },
		scales: {
			y: { min: 0, max: 100, border: { display: false }, ticks: { callback: (v) => `${v}%`, color: mutedC, font: { family: "JetBrains Mono" } }, grid: { color: grid } },
			x: { border: { display: false }, ticks: { color: mutedC }, grid: { display: false } },
		},
		plugins: {
			legend: { position: "bottom", labels: { color: mutedC, boxWidth: 12, boxHeight: 2, padding: 16 } },
			tooltip: { backgroundColor: css("--card"), titleColor: css("--ink"), bodyColor: css("--ink"), borderColor: grid, borderWidth: 1, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y ?? "-"}%` } },
		},
	};
}
const rgba = (c, a) => (c.startsWith("rgb(") ? c.replace("rgb(", "rgba(").replace(")", `,${a})`) : c);
function area(color) {
	return (ctx) => {
		const c = ctx.chart;
		if (!c.chartArea) return "transparent";
		const g = c.ctx.createLinearGradient(0, c.chartArea.top, 0, c.chartArea.bottom);
		g.addColorStop(0, rgba(color, 0.35));
		g.addColorStop(1, rgba(color, 0));
		return g;
	};
}
function drawCharts(P, cur, prev) {
	const brand = css("--brand"), brand2 = css("--brand-2");
	const greys = [css("--comp-1"), css("--comp-2"), css("--comp-3")];
	const trend = P.trend.length ? P.trend : P.cur;
	const labels = trend.map((b) => fmtShort(b.started_at));
	const per = (fn) => trend.map((b) => pct(fn(runsOf([b]))));
	const vis = document.getElementById("ch-vis");
	if (vis) {
		const ds = [{ label: "Visibility", data: per((rs) => metricsOf(rs)?.visibility), borderColor: brand, backgroundColor: area(brand), fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4, pointBackgroundColor: brand }];
		if (S.prevLine && P.prev.length) {
			const prevTrend = P.prev.slice(-trend.length);
			ds.push({ label: "Previous period", data: trend.map((_, i) => { const b = prevTrend[i]; return b ? pct(metricsOf(runsOf([b]))?.visibility) : null; }), borderColor: brand2, borderDash: [6, 4], borderWidth: 2, tension: 0.35, pointRadius: 3 });
		}
		if (S.compareComps) {
			entityRows(cur, prev).filter((r) => !r.me && r.mentions).slice(0, 3).forEach((r, i) => ds.push({ label: r.name, data: per((rs) => (rs.length ? rs.filter((x) => compNamed(x, r.name)).length / rs.length : null)), borderColor: greys[i], borderDash: [2, 3], borderWidth: 1.5, tension: 0.35, pointRadius: 2 }));
		}
		charts.vis = new Chart(vis, { type: "line", data: { labels, datasets: ds }, options: baseOpts() });
	}
	const vis2 = document.getElementById("ch-vis2");
	if (vis2) {
		charts.vis2 = new Chart(vis2, { type: "line", data: { labels, datasets: [
			{ label: "Visibility", data: per((rs) => metricsOf(rs)?.visibility), borderColor: brand, backgroundColor: area(brand), fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4 },
			{ label: "Cited rate", data: per((rs) => metricsOf(rs)?.citedRate), borderColor: brand2, borderWidth: 2, tension: 0.35, pointRadius: 3 },
			{ label: "Citation share", data: per((rs) => metricsOf(rs)?.citationShare), borderColor: brand2, borderDash: [6, 4], borderWidth: 2, tension: 0.35, pointRadius: 3 },
		] }, options: baseOpts() });
	}
	const cat = document.getElementById("ch-cat");
	if (cat) {
		const cites = cur.flatMap((r) => CITES_BY_RUN.get(r.id) || []);
		const counts = cites.reduce((acc, c) => { const k = categoryOf(c.domain); acc.set(k, (acc.get(k) || 0) + 1); return acc; }, new Map());
		const all = sortCategories([...counts.keys()]);
		const baseColors = all.map((c) => categoryColor(c, all));
		charts.cat = new Chart(cat, {
			type: "doughnut",
			data: { labels: all, datasets: [{ data: all.map((c) => counts.get(c)), backgroundColor: baseColors.slice(), borderColor: css("--card"), borderWidth: 2, hoverOffset: 8 }] },
			options: { maintainAspectRatio: false, cutout: "62%", layout: { padding: 12 },
				plugins: { legend: { display: false }, tooltip: { backgroundColor: css("--card"), titleColor: css("--ink"), bodyColor: css("--ink"), borderColor: css("--line"), borderWidth: 1, callbacks: { label: (c) => `${c.label}: ${c.parsed} (${Math.round((c.parsed / cites.length) * 100)}%)` } } },
				onClick: (_e, els) => { if (els[0]) selectCategory(all[els[0].index]); } },
		});
		charts.cat.$baseColors = baseColors;
		if (S.category) highlightDonut();
	}
}

// ---------- answer detail ----------
function answerHtml(text) {
	if (!text) return "(no text)";
	const cleaned = String(text)
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\(\[([^\]]+)\]\([^)]*\)\)/g, "($1)")
		.replace(/\[([^\]]+)\]\((https?:[^)]*)\)/g, "$1")
		.replace(/\\([.\-#*_()[\]!:$])/g, "$1")
		.replace(/^-{3,}$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return esc(cleaned).replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}
async function openPrompt(prompt, runs) {
	const matches = runs.filter((r) => r.prompt === prompt);
	document.getElementById("d-title").textContent = prompt;
	const body = document.getElementById("d-body");
	body.innerHTML = "Loading…";
	document.getElementById("detail").showModal();
	try {
		const parts = await Promise.all(matches.map(async (r) => {
			const d = await rpc("client_run_detail", { p_session: SESSION, p_run_id: r.id });
			const cites = (CITES_BY_RUN.get(r.id) || []).slice().sort((a, b) => a.position - b.position);
			const when = (DATA.batches.find((b) => b.id === r.batch_id) || {}).started_at;
			return `<h4>${esc(SOURCES[r.provider] || r.provider)} ${muted(`${esc(r.model_version || "")}${when ? ` · ${fmtDate(when)}` : ""}`)} ${pill(r)}</h4>
				<pre>${answerHtml(d?.text_content)}</pre>
				<h4>Sources (${cites.length})</h4>
				<ol>${cites.map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.domain)}</a> ${muted(`${esc(c.domain)} · ${esc(categoryOf(c.domain))}`)}</li>`).join("") || `<li>${muted("None")}</li>`}</ol>
				${d?.web_queries?.length ? `<h4>Searches it ran</h4><ul>${d.web_queries.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}<hr>`;
		}));
		body.innerHTML = parts.join("");
	} catch (e) {
		body.innerHTML = `<div class="err">Couldn't load this answer. ${esc(e.message)}</div>`;
	}
}

// ---------- login + boot ----------
function showLogin(message) {
	DATA = null;
	SESSION = null;
	document.getElementById("favicon").href = "data:,";
	document.title = "AI Visibility";
	for (const v of ["--brand", "--brand-2", "--brand-soft", "--on-brand"]) document.documentElement.style.removeProperty(v);
	document.getElementById("app").innerHTML = `<div class="login-wrap"><div class="login card">
		<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h1>AI visibility dashboard</h1>${themeButton()}</div>
		<p style="color:var(--muted);margin:0">Sign in with the username and password you were given.</p>
		<form id="login-form">
			<input id="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Username" required aria-label="Username">
			<input id="pw" type="password" autocomplete="current-password" placeholder="Password" required aria-label="Password">
			<button type="submit" id="login-btn">Sign in</button>
		</form>
		${message ? `<div class="alert bad" role="alert"><b>${esc(message)}</b></div>` : ""}</div></div>`;
	document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
	document.getElementById("user").focus();
	document.getElementById("login-form").addEventListener("submit", async (e) => {
		e.preventDefault();
		const btn = document.getElementById("login-btn");
		btn.disabled = true;
		btn.textContent = "Signing in…";
		try {
			const res = await rpc("dashboard_login", { p_username: document.getElementById("user").value, p_password: document.getElementById("pw").value });
			if (res?.session) { store.set(SESSION_KEY, res.session); return load(res.session); }
			if (res?.error === "locked") {
				const mins = Math.max(1, Math.ceil((new Date(res.until) - Date.now()) / 60000));
				return showLogin(`Too many wrong attempts. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`);
			}
			showLogin("Username or password isn't right.");
		} catch (err) {
			showLogin(`Couldn't sign in. ${err.message}`);
		}
	});
}
async function logout() {
	try { await rpc("dashboard_logout", { p_session: SESSION }); } catch {}
	store.del(SESSION_KEY);
	for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
	showLogin();
}
async function load(session) {
	const app = document.getElementById("app");
	if (!session) return showLogin();
	try {
		const data = await rpc("client_dashboard", { p_session: session });
		if (!data || data.error === "session") {
			store.del(SESSION_KEY);
			return showLogin(data ? "Your session ended. Please sign in again." : null);
		}
		SESSION = session;
		DATA = data;
		indexData();
		applyTheme(DATA.client.branding);
		document.title = `${DATA.client.name} · AI Visibility`;
		const ic = DATA.client.branding?.icon_url;
		if (/^https:\/\//.test(ic || "")) document.getElementById("favicon").href = ic;
		if (!DATA.runs.some((r) => r.provider === S.model)) S.model = "all";
		const t = location.hash.slice(1);
		if (TABS.some(([id]) => id === t)) S.tab = t;
		renderApp();
	} catch (e) {
		app.innerHTML = `<div class="card err">Couldn't load data. ${esc(e.message)}</div>`;
	}
}
if (new URLSearchParams(location.search).has("c")) history.replaceState(null, "", location.pathname + location.hash);
load(store.get(SESSION_KEY));
