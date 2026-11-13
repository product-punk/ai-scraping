// Client AI-visibility dashboard. Metric definitions match the aeo-data-analysis
// skill so the dashboard and the weekly Excel report agree:
//   Visibility      = answers naming the brand / answers (run grain)
//   Cited rate      = answers citing the brand's domain / answers
//   SOV             = brand mentions / (brand + tracked competitor mentions)
//   Citation share  = brand-domain citations / all citations
//   Citation SOV    = brand citations / (brand + tracked competitor domain citations)
//   Fan-out referral= surfaced search results whose domain/URL the answer cited
// Headline visibility/SOV use commercial prompts; branded/comparison prompts are reported separately.

const SOURCES = { "chatgpt-scraped": "Live ChatGPT", "openai-api": "OpenAI API" };
const ENGINES = { "chatgpt-scraped": "Live ChatGPT", "openai-api": "OpenAI API", all: "Combined" };
const token = new URLSearchParams(location.search).get("c");
const PW_KEY = `aeo-dash-pw:${token}`;
let DATA = null, ENGINE = "chatgpt-scraped", chart = null, PASSWORD = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const pct = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100));
const pctTxt = (x) => (pct(x) == null ? "-" : `${pct(x)}%`);
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const store = {
	get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
	set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
	del(k) { try { sessionStorage.removeItem(k); } catch {} },
};

// ---------- Domains (skill: last two labels, special-case 2-level TLDs; strip utm) ----------
const TWO_LEVEL = new Set(["co.uk", "gov.uk", "ac.uk", "org.uk", "com.au", "net.au", "org.au", "com.sg", "co.in", "ac.in", "edu.in", "gov.in", "org.in", "net.in", "res.in", "nic.in", "co.nz", "com.br", "co.jp", "ac.jp"]);
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

// ---------- Theming from client brand colours ----------
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
	// Lighten on dark surfaces, darken on light ones, until the colour reads as text.
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
	if (!p) {
		for (const v of ["--brand", "--brand-2", "--brand-soft", "--on-brand"]) root.removeProperty(v);
		return;
	}
	const brand = readableOn(p, card);
	const second = hexToRgb(branding?.accent);
	const brand2 = second ? readableOn(second, card) : brand.map((v) => Math.round(v * 0.7 + (card[0] > 128 ? 0 : 255) * 0.3));
	root.setProperty("--brand", `rgb(${brand.join(",")})`);
	root.setProperty("--brand-2", `rgb(${brand2.join(",")})`);
	root.setProperty("--brand-soft", `rgba(${brand.join(",")},${card[0] > 128 ? 0.1 : 0.14})`);
	root.setProperty("--on-brand", contrast(brand, [255, 255, 255]) >= contrast(brand, [11, 11, 11]) ? "#ffffff" : "#0b0b0b");
}
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const themeButton = () => {
	const next = currentTheme() === "dark" ? "light" : "dark";
	return `<button class="theme-btn" id="theme-toggle" type="button" aria-label="Switch to ${next} mode" title="Switch to ${next} mode">${next === "light" ? SUN : MOON}</button>`;
};
function toggleTheme() {
	const next = currentTheme() === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	try { localStorage.setItem("aeo-dash-theme", next); } catch {}
	applyTheme(DATA?.client?.branding);
	if (DATA) {
		render(); // re-binds the new header button itself
		return;
	}
	// Login screen: swap just the button so a half-typed password survives.
	const holder = document.createElement("span");
	holder.innerHTML = themeButton();
	document.getElementById("theme-toggle")?.replaceWith(holder.firstChild);
	bindTheme();
}
function bindTheme() {
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

// ---------- Data model helpers ----------
let CLIENT_DOMAIN = "", COMP_DOMAINS = new Map(), CITES_BY_RUN = new Map(), FANOUT_BY_RUN = new Map(), RUN_BY_ID = new Map();

function indexData() {
	CLIENT_DOMAIN = baseDomain(DATA.client.domain);
	COMP_DOMAINS = new Map();
	for (const c of DATA.client.competitors) for (const d of c.domains || []) COMP_DOMAINS.set(baseDomain(d), c.name);
	CITES_BY_RUN = new Map(); FANOUT_BY_RUN = new Map(); RUN_BY_ID = new Map(DATA.runs.map((r) => [r.id, r]));
	for (const c of DATA.citations) (CITES_BY_RUN.get(c.run_id) || CITES_BY_RUN.set(c.run_id, []).get(c.run_id)).push(c);
	for (const s of DATA.fanout || []) (FANOUT_BY_RUN.get(s.run_id) || FANOUT_BY_RUN.set(s.run_id, []).get(s.run_id)).push(s);
}

const tags = () => DATA.client.prompt_tags || {};
const intentOf = (prompt) => (tags()[prompt]?.intent || "").toLowerCase();
const isBranded = (prompt) => ["branded", "comparison", "branded/comparison"].includes(intentOf(prompt));
const hasIntentTags = () => DATA.client.prompts.some((p) => intentOf(p));
const isCommercial = (prompt) => (hasIntentTags() ? intentOf(prompt) === "commercial" : !isBranded(prompt));

function offeringOf(prompt) {
	const tagged = tags()[prompt]?.offering;
	if (tagged) return tagged;
	const lower = prompt.toLowerCase();
	const hits = (DATA.client.offerings || []).filter((o) => [o.name, ...(o.keywords || [])].some((k) => k && lower.includes(String(k).toLowerCase())));
	return hits.length === 1 ? hits[0].name : hits.length > 1 ? "Multiple" : "General";
}

const runsIn = (batchId, engine = ENGINE) => DATA.runs.filter((r) => r.batch_id === batchId && (engine === "all" || r.provider === engine));
const visible = (r) => r.brand_mentioned || r.brand_cited;
const compNamed = (r, name) => r.competitors_mentioned.includes(name);
const compVisible = (r, name) => compNamed(r, name) || r.competitors_cited.includes(name);

/** All skill metrics for a set of runs. */
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
		const domains = new Set(rc.map((c) => baseDomain(c.domain)));
		const urls = new Set(rc.map((c) => normUrl(c.url)));
		for (const f of fan) {
			surfaced++;
			if (domains.has(baseDomain(f.domain)) || urls.has(normUrl(f.url))) referred++;
		}
	}
	return {
		n,
		visibility: brandMentions / n,
		citedRate: runs.filter((r) => r.brand_cited).length / n,
		sov: brandMentions + compMentions ? brandMentions / (brandMentions + compMentions) : 0,
		citationShare: cites.length ? brandCites / cites.length : null,
		citationSov: brandCites + compCites ? brandCites / (brandCites + compCites) : null,
		citations: cites.length,
		referral: surfaced ? referred / surfaced : null,
		surfaced, referred,
	};
}

// ---------- UI pieces ----------
function delta(cur, prev) {
	if (cur == null || prev == null) return `<span class="delta flat">First week · no comparison yet</span>`;
	const d = pct(cur) - pct(prev);
	const cls = d === 0 ? "flat" : d > 0 ? "up" : "down";
	return `<span class="delta ${cls}">${d > 0 ? "▲ +" : d < 0 ? "▼ " : "■ "}${d} pts vs last week</span>`;
}
function kpi(label, value, prev, note) {
	const v = pct(value);
	return `<div class="card kpi c3"><div class="label">${esc(label)}</div>
		<div class="val">${v ?? "-"}<span class="unit">%</span></div>
		<div class="bar"><span style="width:${v ?? 0}%"></span></div>${delta(value, prev)}${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
}
const pill = (run) => run
	? `<span class="pill"><span class="${run.brand_mentioned ? "yes" : ""}">NAMED</span><span class="${run.brand_cited ? "yes" : ""}">CITED</span></span>`
	: `<span class="sub">-</span>`;

function computeAlerts(curRuns, prevRuns) {
	const out = [];
	if (!prevRuns.length) {
		out.push({ kind: "info", title: "Baseline week", text: "This is the first scrape on record. Week-over-week changes appear after the next Monday run." });
		return out;
	}
	const key = (r) => `${r.prompt}|${r.provider}`;
	const prevBy = new Map(prevRuns.map((r) => [key(r), r]));
	for (const r of curRuns) {
		const p = prevBy.get(key(r));
		if (!p) continue;
		const label = `${r.prompt.length > 70 ? `${r.prompt.slice(0, 70)}…` : r.prompt} (${SOURCES[r.provider]})`;
		if (p.brand_mentioned && !r.brand_mentioned) out.push({ kind: "bad", title: "No longer named", text: label });
		if (!p.brand_mentioned && r.brand_mentioned) out.push({ kind: "good", title: "Now named", text: label });
		if (p.brand_cited && !r.brand_cited) out.push({ kind: "bad", title: "Website no longer cited", text: label });
		if (!p.brand_cited && r.brand_cited) out.push({ kind: "good", title: "Website now cited", text: label });
	}
	for (const c of DATA.client.competitors) {
		const now = curRuns.filter((r) => compNamed(r, c.name)).length / curRuns.length;
		const before = prevRuns.filter((r) => compNamed(r, c.name)).length / prevRuns.length;
		if (now - before >= 0.25) out.push({ kind: "bad", title: `${c.name} gaining`, text: `Named in ${pct(now)}% of answers, up from ${pct(before)}%.` });
	}
	if (!out.length) out.push({ kind: "info", title: "No major changes", text: "Every prompt held its result versus last week." });
	return out;
}

// ---------- Render ----------
function header(batchesAll) {
	const { client } = DATA;
	const b = client.branding || {};
	const iconOk = typeof b.icon_url === "string" && /^https:\/\//.test(b.icon_url);
	const initials = client.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
	const logo = iconOk ? `<div class="logo"><img src="${esc(b.icon_url)}" alt="${esc(client.name)} logo"></div>` : `<div class="logo initials">${esc(initials)}</div>`;
	const seg = `<div class="seg" role="tablist">${Object.entries(ENGINES)
		.map(([k, v]) => `<button role="tab" aria-selected="${k === ENGINE}" class="${k === ENGINE ? "on" : ""}" data-engine="${k}">${esc(v)}</button>`).join("")}</div>`;
	const last = batchesAll[batchesAll.length - 1];
	return `<header>
		<div class="who">${logo}<div><h1>${esc(client.name)}</h1><div class="sub">${esc(client.domain)} · AI search visibility</div></div></div>
		<div class="controls">${last ? `<span class="live"><i></i>Updated ${fmtDate(last.started_at)}</span>` : ""}${seg}${themeButton()}</div>
	</header>`;
}

function render() {
	const { client } = DATA;
	const app = document.getElementById("app");
	const batches = DATA.batches.filter((b) => runsIn(b.id).length > 0);
	if (!batches.length) {
		app.innerHTML = `${header(DATA.batches)}<div class="card empty">No data for this source yet. It appears after the next weekly run.</div>`;
		bindSeg();
		return;
	}
	const latest = batches[batches.length - 1];
	const prev = batches.length > 1 ? batches[batches.length - 2] : null;
	const cur = runsIn(latest.id), old = prev ? runsIn(prev.id) : [];
	const commercial = (rs) => rs.filter((r) => isCommercial(r.prompt));
	const branded = (rs) => rs.filter((r) => isBranded(r.prompt));
	const mAll = metricsOf(cur), pAll = prev ? metricsOf(old) : null;
	const mCom = metricsOf(commercial(cur)), pCom = prev ? metricsOf(commercial(old)) : null;
	const mBr = metricsOf(branded(cur));
	const tagged = hasIntentTags();
	const comNote = tagged ? `${mCom?.n ?? 0} commercial answers` : "Prompts not tagged by intent yet: showing all non-branded prompts";

	// Scorecard by source (always all sources, latest batch).
	const scoreRows = ["chatgpt-scraped", "openai-api", "all"].map((e) => {
		const rs = runsIn(latest.id, e);
		return { label: ENGINES[e], m: metricsOf(rs), mc: metricsOf(commercial(rs)) };
	}).filter((x) => x.m);

	// Offering performance.
	const offeringNames = [...new Set(cur.map((r) => offeringOf(r.prompt)))];
	const offerings = offeringNames.map((name) => {
		const rs = cur.filter((r) => offeringOf(r.prompt) === name && !isBranded(r.prompt));
		const prompts = new Set(rs.map((r) => r.prompt)).size;
		const m = metricsOf(rs);
		const top = DATA.client.competitors.map((c) => ({ name: c.name, n: rs.filter((r) => compNamed(r, c.name)).length }))
			.sort((a, b) => b.n - a.n)[0];
		return { name, prompts, m, top: top && top.n ? `${top.name} (${top.n})` : "-" };
	}).filter((o) => o.m).sort((a, b) => b.m.visibility - a.m.visibility);

	// Competitors (named-based SOV, cited rate).
	const brandMentions = cur.filter((r) => r.brand_mentioned).length;
	const compRows = DATA.client.competitors.map((c) => ({
		name: c.name,
		named: cur.filter((r) => compNamed(r, c.name)).length / cur.length,
		cited: cur.filter((r) => r.competitors_cited.includes(c.name)).length / cur.length,
		mentions: cur.filter((r) => compNamed(r, c.name)).length,
		prevNamed: prev ? old.filter((r) => compNamed(r, c.name)).length / old.length : null,
	}));
	const totalMentions = brandMentions + compRows.reduce((a, c) => a + c.mentions, 0);
	const leaderboard = [{ name: client.name, me: true, named: mAll.visibility, cited: mAll.citedRate, mentions: brandMentions, prevNamed: pAll?.visibility ?? null }]
		.concat(compRows).filter((r) => r.me || r.named > 0 || r.cited > 0 || (r.prevNamed ?? 0) > 0)
		.sort((a, b) => (Number(Boolean(b.me)) - Number(Boolean(a.me))) || (b.named - a.named) || (b.cited - a.cited));

	// Sources: citation counts, tracked tags, untracked frequently cited.
	const count = (rs) => rs.flatMap((r) => CITES_BY_RUN.get(r.id) || []).reduce((acc, c) => acc.set(baseDomain(c.domain), (acc.get(baseDomain(c.domain)) || 0) + 1), new Map());
	const curDom = count(cur), prevDom = count(old);
	const domains = [...curDom.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
	const maxDom = domains[0]?.[1] || 1;
	const tagFor = (d) => (d === CLIENT_DOMAIN ? `<span class="tag me">You</span>` : COMP_DOMAINS.has(d) ? `<span class="tag">${esc(COMP_DOMAINS.get(d))}</span>` : "");

	// Fan-out: surfaced but never cited.
	const surfacedNotCited = new Map();
	for (const r of cur) {
		const citedDomains = new Set((CITES_BY_RUN.get(r.id) || []).map((c) => baseDomain(c.domain)));
		for (const f of FANOUT_BY_RUN.get(r.id) || []) {
			const d = baseDomain(f.domain);
			if (d && !citedDomains.has(d)) surfacedNotCited.set(d, (surfacedNotCited.get(d) || 0) + 1);
		}
	}
	const fanTop = [...surfacedNotCited.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	const clientSurfaced = cur.some((r) => (FANOUT_BY_RUN.get(r.id) || []).some((f) => baseDomain(f.domain) === CLIENT_DOMAIN));

	const insight = (DATA.insights || []).find((i) => i.batch_id === latest.id);
	const alerts = computeAlerts(cur, old);
	const order = new Map(client.prompts.map((q, i) => [q, i]));
	const prompts = [...new Set(cur.map((r) => r.prompt))].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
	const engines = ENGINE === "all" ? ["chatgpt-scraped", "openai-api"] : [ENGINE];
	const actions = insight?.content?.actions || [];
	const outreach = insight?.content?.outreach || [];

	document.getElementById("app").innerHTML = `${header(DATA.batches)}
	<div class="grid kpis">
		${kpi("Visibility · commercial prompts", mCom?.visibility ?? null, pCom?.visibility, comNote)}
		${kpi("Visibility · all prompts", mAll.visibility, pAll?.visibility)}
		${kpi("Share of voice · commercial", mCom?.sov ?? null, pCom?.sov)}
		${kpi("Brand citation share", mAll.citationShare, pAll?.citationShare, `${mAll.citations} citations this week`)}
	</div>
	<div class="grid">
		<div class="card c8"><h2>Visibility over time <small>${batches.length} week${batches.length > 1 ? "s" : ""} · ${esc(ENGINES[ENGINE])}</small></h2><div class="chartbox"><canvas id="trend" role="img" aria-label="Visibility trend chart"></canvas></div></div>
		<div class="card c4"><h2>This week <small>${fmtDate(latest.started_at)}</small></h2>
			${insight ? `<p class="headline">${esc(insight.headline)}</p>${insight.summary ? `<p class="summary">${esc(insight.summary)}</p>` : ""}` : ""}
			<div class="alerts">${alerts.slice(0, 6).map((a) => `<div class="alert ${a.kind}"><b>${esc(a.title)}</b>${esc(a.text)}</div>`).join("")}</div>
		</div>
	</div>
	<div class="grid"><div class="card c12"><h2>Scorecard by source <small>latest week · commercial in brackets</small></h2><div class="scroll"><table>
		<thead><tr><th>Source</th><th class="num">Answers</th><th class="num">Visibility</th><th class="num">Cited rate</th><th class="num">Citation share</th><th class="num">Share of voice</th><th class="num">Citation SOV</th><th class="num">Fan-out referral</th></tr></thead><tbody>
		${scoreRows.map(({ label, m, mc }) => `<tr${label === ENGINES[ENGINE] ? ' class="me"' : ""}><td>${esc(label)}</td><td class="num">${m.n}</td>
			<td class="num">${pctTxt(m.visibility)} <span class="sub">(${pctTxt(mc?.visibility)})</span></td><td class="num">${pctTxt(m.citedRate)}</td>
			<td class="num">${pctTxt(m.citationShare)}</td><td class="num">${pctTxt(m.sov)} <span class="sub">(${pctTxt(mc?.sov)})</span></td>
			<td class="num">${pctTxt(m.citationSov)}</td><td class="num">${m.surfaced ? `${pctTxt(m.referral)} <span class="sub">${m.referred}/${m.surfaced}</span>` : "-"}</td></tr>`).join("")}
		</tbody></table></div>${mBr ? `<div class="note">Branded and comparison prompts (${mBr.n} answers) are excluded from commercial figures: visibility ${pctTxt(mBr.visibility)}.</div>` : ""}</div></div>
	<div class="grid"><div class="card c12"><h2>Offering performance <small>non-branded prompts · strongest to weakest</small></h2><div class="scroll"><table>
		<thead><tr><th>Offering</th><th class="num">Prompts</th><th class="num">Visibility</th><th class="num">Cited rate</th><th class="num">Citation share</th><th class="num">SOV</th><th>Top competitor</th></tr></thead><tbody>
		${offerings.map((o) => `<tr><td>${esc(o.name)}${o.prompts < 3 ? '<span class="tag dir" title="Fewer than 3 prompts: one run per prompt and source">Directional</span>' : ""}</td>
			<td class="num">${o.prompts}</td><td class="num">${pctTxt(o.m.visibility)}</td><td class="num">${pctTxt(o.m.citedRate)}</td>
			<td class="num">${pctTxt(o.m.citationShare)}</td><td class="num">${pctTxt(o.m.sov)}</td><td>${esc(o.top)}</td></tr>`).join("") || `<tr><td colspan="7" class="sub">No offerings yet.</td></tr>`}
		</tbody></table></div>${(client.offerings || []).length ? "" : `<div class="note">Offerings not set up yet: prompts are grouped as "General" until the weekly analysis defines them.</div>`}</div></div>
	<div class="grid">
		<div class="card c6"><h2>You vs competitors <small>named · cited · share of mentions</small></h2><div class="scroll"><table>
			<thead><tr><th>Company</th><th class="num">Named</th><th class="num">Cited</th><th class="num">SOV</th><th class="num">Last wk</th></tr></thead><tbody>
			${leaderboard.map((r) => `<tr class="${r.me ? "me" : ""}"><td>${esc(r.name)}${r.me ? '<span class="tag me">You</span>' : ""}</td>
				<td class="num"><span class="minibar"><span style="width:${pct(r.named)}%"></span></span>${pctTxt(r.named)}</td><td class="num">${pctTxt(r.cited)}</td>
				<td class="num">${totalMentions ? pctTxt(r.mentions / totalMentions) : "-"}</td><td class="num">${prev ? pctTxt(r.prevNamed) : "-"}</td></tr>`).join("")}
		</tbody></table></div></div>
		<div class="card c6"><h2>Most-cited sources <small>citation SOV ${pctTxt(mAll.citationSov)}</small></h2><div class="scroll"><table>
			<thead><tr><th>Domain</th><th class="num">Citations</th><th class="num">Last wk</th></tr></thead><tbody>
			${domains.map(([d, n]) => `<tr><td>${esc(d)}${tagFor(d)}</td><td class="num"><span class="minibar"><span style="width:${(n / maxDom) * 100}%;background:var(--brand-2)"></span></span>${n}</td><td class="num">${prev ? prevDom.get(d) || 0 : "-"}</td></tr>`).join("") || `<tr><td colspan="3" class="sub">No citations.</td></tr>`}
		</tbody></table></div><div class="note">Untagged domains are not tracked competitors. If one sells what you sell and is cited often, add it as a competitor.</div></div>
	</div>
	<div class="grid">
		<div class="card c6"><h2>Fan-out <small>pages ChatGPT's search surfaced</small></h2>
			${mAll.surfaced ? `<p class="summary">${mAll.surfaced} results surfaced, ${mAll.referred} referred to in answers (${pctTxt(mAll.referral)}). Your site ${clientSurfaced ? "<b>was surfaced</b>" : "was <b>not</b> surfaced"} this week.</p>
			<div class="scroll"><table><thead><tr><th>Surfaced but not cited</th><th class="num">Times</th></tr></thead><tbody>
			${fanTop.map(([d, n]) => `<tr><td>${esc(d)}${tagFor(d)}</td><td class="num">${n}</td></tr>`).join("")}</tbody></table></div>`
			: `<p class="summary">No fan-out data for this source (the OpenAI API doesn't expose surfaced results).</p>`}
		</div>
		${actions.length ? `<div class="card c6"><h2>Priority actions</h2><ol class="actions">${actions.map((a) => `<li><b>${esc(a.title)}</b><span>${esc(a.detail || "")}</span></li>`).join("")}</ol></div>`
			: `<div class="card c6"><h2>Priority actions</h2><p class="summary">Actions appear here after this week's analysis is published.</p></div>`}
	</div>
	<div class="grid"><div class="card c12"><h2>Prompts <small>click a row to read the full answer</small></h2><div class="scroll"><table>
		<thead><tr><th>Prompt</th><th>Offering · intent</th>${engines.map((e) => `<th>${esc(SOURCES[e])}</th><th>Last wk</th>`).join("")}</tr></thead><tbody>
		${prompts.map((q) => `<tr class="prompt" tabindex="0" data-prompt="${esc(q)}"><td>${esc(q)}</td><td class="sub">${esc(offeringOf(q))}${intentOf(q) ? ` · ${esc(intentOf(q))}` : ""}</td>${engines.map((e) => {
			const now = cur.find((r) => r.prompt === q && r.provider === e);
			const before = old.find((r) => r.prompt === q && r.provider === e);
			return `<td>${pill(now)}</td><td>${prev ? pill(before) : '<span class="sub">-</span>'}</td>`;
		}).join("")}</tr>`).join("")}
		</tbody></table></div></div></div>
	${outreach.length ? `<div class="grid"><div class="card c12"><h2>Outreach targets <small>sites AI engines cite for your topics</small></h2><div class="scroll"><table>
		<thead><tr><th>Site</th><th>Tier</th><th>Page cited</th><th>Angle</th></tr></thead><tbody>
		${outreach.slice(0, 15).map((o) => `<tr><td>${esc(o.domain)}</td><td>${o.tier ? `<span class="tag ${esc(String(o.tier).toLowerCase())}">${esc(o.tier)}</span>` : ""}</td>
			<td>${o.url ? `<a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.url.replace(/^https?:\/\//, "").slice(0, 60))}</a>` : ""}</td><td class="sub">${esc(o.angle || o.gap || "")}</td></tr>`).join("")}
	</tbody></table></div></div></div>` : ""}
	<div class="foot"><b>Visibility</b>: share of answers that name the company. <b>Cited rate</b>: share of answers that cite its website. <b>Share of voice</b>: its mentions ÷ its plus tracked competitors' mentions. <b>Citation share</b>: its website's citations ÷ all citations. <b>Citation SOV</b>: its citations ÷ its plus tracked competitors' citations. <b>Fan-out referral</b>: surfaced search results the answer went on to cite. One run per prompt and source each week; answers vary run to run, so read trends across several weeks.</div>`;

	bindSeg();
	document.querySelectorAll("tr.prompt").forEach((tr) => {
		const open = () => openPrompt(tr.dataset.prompt, cur);
		tr.addEventListener("click", open);
		tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
	});
	drawTrend(batches, leaderboard.filter((r) => !r.me).slice(0, 2).map((r) => r.name));
}

function bindSeg() {
	bindTheme();
	document.querySelectorAll("[data-engine]").forEach((b) => b.addEventListener("click", () => { ENGINE = b.dataset.engine; render(); }));
}

function drawTrend(batches, topComps) {
	if (chart) chart.destroy();
	const labels = batches.map((b) => fmtDate(b.started_at));
	const series = (fn) => batches.map((b) => pct(fn(runsIn(b.id))));
	const brand = css("--brand"), brand2 = css("--brand-2"), grid = css("--line"), muted = css("--muted");
	const rgba = (c, a) => c.replace("rgb(", "rgba(").replace(")", `,${a})`);
	const areaFill = (ctx) => {
		const c = ctx.chart;
		if (!c.chartArea) return "transparent";
		const g = c.ctx.createLinearGradient(0, c.chartArea.top, 0, c.chartArea.bottom);
		g.addColorStop(0, rgba(brand, 0.35));
		g.addColorStop(1, rgba(brand, 0));
		return g;
	};
	const greys = [css("--comp-1"), css("--comp-2")];
	chart = new Chart(document.getElementById("trend"), {
		type: "line",
		data: { labels, datasets: [
			{ label: "Visibility", data: series((rs) => metricsOf(rs)?.visibility), borderColor: brand, backgroundColor: areaFill, fill: true, borderWidth: 3, tension: 0.35, pointRadius: 4, pointBackgroundColor: brand },
			{ label: "Cited rate", data: series((rs) => metricsOf(rs)?.citedRate), borderColor: brand2, backgroundColor: brand2, borderWidth: 2, tension: 0.35, pointRadius: 3 },
			{ label: "Citation share", data: series((rs) => metricsOf(rs)?.citationShare), borderColor: brand2, backgroundColor: brand2, borderDash: [6, 4], borderWidth: 2, tension: 0.35, pointRadius: 3 },
			...topComps.map((name, i) => ({ label: `${name} visibility`, data: series((rs) => (rs.length ? rs.filter((r) => compNamed(r, name)).length / rs.length : null)), borderColor: greys[i], backgroundColor: greys[i], borderWidth: 1.5, borderDash: [2, 3], tension: 0.35, pointRadius: 2 })),
		] },
		options: {
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			scales: {
				y: { min: 0, max: 100, border: { display: false }, ticks: { callback: (v) => `${v}%`, color: muted, font: { family: "JetBrains Mono" } }, grid: { color: grid } },
				x: { border: { display: false }, ticks: { color: muted }, grid: { display: false } },
			},
			plugins: {
				legend: { position: "bottom", labels: { color: muted, boxWidth: 12, boxHeight: 2, padding: 16 } },
				tooltip: { backgroundColor: css("--card"), titleColor: css("--ink"), bodyColor: css("--ink"), borderColor: grid, borderWidth: 1, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}%` } },
			},
		},
	});
}

/** Readable answer text: drop images and link targets, keep bold/headings. Escapes before adding tags. */
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
	return esc(cleaned)
		.replace(/^#{1,6}\s*(.+)$/gm, "<b>$1</b>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

async function openPrompt(prompt, runs) {
	const matches = runs.filter((r) => r.prompt === prompt);
	document.getElementById("d-title").textContent = prompt;
	const body = document.getElementById("d-body");
	body.innerHTML = "Loading…";
	document.getElementById("detail").showModal();
	try {
		const parts = await Promise.all(matches.map(async (r) => {
			const d = await rpc("client_run_detail", { p_token: token, p_run_id: r.id, p_password: PASSWORD });
			const cites = (CITES_BY_RUN.get(r.id) || []).slice().sort((a, b) => a.position - b.position);
			return `<h3>${esc(SOURCES[r.provider] || r.provider)} <span class="sub">${esc(r.model_version || "")}</span> ${pill(r)}</h3>
				<pre>${answerHtml(d?.text_content)}</pre>
				<h3>Sources (${cites.length})</h3>
				<ol>${cites.map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title || c.domain)}</a> <span class="sub">${esc(c.domain)}</span></li>`).join("") || "<li class='sub'>None</li>"}</ol>
				${d?.web_queries?.length ? `<h3>Searches it ran</h3><ul>${d.web_queries.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}<hr>`;
		}));
		body.innerHTML = parts.join("");
	} catch (e) {
		body.innerHTML = `<div class="err">Couldn't load this answer. ${esc(e.message)}</div>`;
	}
}

// ---------- Password gate + boot ----------
function showLogin(message) {
	document.getElementById("app").innerHTML = `<div class="login card">
		<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h1>AI visibility dashboard</h1>${themeButton()}</div><p class="sub">Enter the password you were given for this dashboard.</p>
		<form id="pw-form"><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required aria-label="Password">
		<button type="submit">Open dashboard</button></form>
		${message ? `<div class="alert bad" role="alert"><b>${esc(message)}</b></div>` : ""}</div>`;
	const input = document.getElementById("pw");
	bindTheme();
	input.focus();
	document.getElementById("pw-form").addEventListener("submit", (e) => {
		e.preventDefault();
		load(input.value);
	});
}

async function load(password) {
	const app = document.getElementById("app");
	try {
		const data = await rpc("client_dashboard", { p_token: token, p_password: password || null });
		if (!data) { app.innerHTML = `<div class="card err">This link isn't recognised.</div>`; return; }
		if (data.error === "password") {
			store.del(PW_KEY);
			showLogin(password ? "That password isn't right." : null);
			return;
		}
		PASSWORD = password || null;
		if (PASSWORD) store.set(PW_KEY, PASSWORD);
		DATA = data;
		indexData();
		applyTheme(DATA.client.branding);
		document.title = `${DATA.client.name} · AI Visibility`;
		const icon = DATA.client.branding?.icon_url;
		if (typeof icon === "string" && /^https:\/\//.test(icon)) document.getElementById("favicon").href = icon;
		if (!DATA.runs.some((r) => r.provider === ENGINE)) ENGINE = "all";
		render();
	} catch (e) {
		app.innerHTML = `<div class="card err">Couldn't load data. ${esc(e.message)}</div>`;
	}
}

if (!token) document.getElementById("app").innerHTML = `<div class="card err">This dashboard needs a client link (…/?c=…).</div>`;
else load(store.get(PW_KEY));
