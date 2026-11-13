// Scrape a client's brand icon + colours from its website, store the icon in
// Supabase Storage (public bucket, keyed by client uuid) and the colours in
// clients.profile.branding. The dashboard themes itself from these.
//
//   node weekly-tracker/scripts/brand.ts --client acme                 # scrape + save
//   node weekly-tracker/scripts/brand.ts --client acme --dry-run       # show picks only
//   node weekly-tracker/scripts/brand.ts --client acme --primary "#0a5" --accent "#f90"   # manual override
import { parseArgs } from "node:util";
import { type Client, env, sb } from "./lib.ts";

const { values } = parseArgs({
	options: {
		client: { type: "string" },
		"dry-run": { type: "boolean", default: false },
		primary: { type: "string" },
		accent: { type: "string" },
		dark: { type: "string" },
		icon: { type: "string" }, // explicit icon/logo URL to use instead of scraping
	},
});
if (!values.client) {
	console.error('Usage: brand.ts --client <slug> [--dry-run] [--primary "#hex"] [--accent "#hex"] [--dark "#hex"] [--icon <url>]');
	process.exit(1);
}

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function get(url: string): Promise<Response | null> {
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
		return res.ok ? res : null;
	} catch {
		return null;
	}
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];

// ---------- Colour maths ----------

type RGB = [number, number, number];
const hex = (rgb: RGB) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function parseColor(s: string): RGB | null {
	s = s.trim().toLowerCase();
	let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
	if (m) {
		const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
	}
	m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
	if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
	// Tailwind-style "hsl(var)" tokens: "210 40% 50%" or "hsl(210 40% 50%)"
	m = s.match(/^(?:hsla?\()?\s*(\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%/);
	if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
	return null;
}
function rgbToHsl([r, g, b]: RGB): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}
function hslToRgb(h: number, s: number, l: number): RGB {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const hueDist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// ---------- Colour extraction ----------

interface Candidate { rgb: RGB; score: number }

function collectColors(css: string, html: string): Map<string, Candidate> {
	const found = new Map<string, Candidate>();
	const add = (raw: string, weight: number) => {
		const rgb = parseColor(raw);
		if (!rgb) return;
		const key = hex(rgb);
		const c = found.get(key) ?? { rgb, score: 0 };
		c.score += weight;
		found.set(key, c);
	};
	// Strong signals: <meta name="theme-color"> and brand-ish custom properties.
	for (const tag of html.match(/<meta[^>]+theme-color[^>]*>/gi) ?? []) {
		const v = attr(tag, "content");
		if (v) add(v, 40);
	}
	for (const m of css.matchAll(/--([\w-]*(?:primary|brand|accent|secondary|main)[\w-]*)\s*:\s*([^;}]+)/gi)) {
		add(m[2], /primary|brand|main/i.test(m[1]) && !/foreground|fg|text/i.test(m[1]) ? 25 : 8);
	}
	// Weak signal: frequency across stylesheets.
	for (const m of css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]+\)/gi)) add(m[0], 1);
	return found;
}

function pickPalette(found: Map<string, Candidate>) {
	const all = [...found.values()].map((c) => ({ ...c, hsl: rgbToHsl(c.rgb) }));
	const vivid = all
		.filter(({ hsl: [, s, l] }) => s >= 0.35 && l >= 0.18 && l <= 0.82)
		.sort((a, b) => b.score - a.score);
	const primary = vivid[0];
	const accent = vivid.find((c) => primary && hueDist(c.hsl[0], primary.hsl[0]) >= 30);
	const dark = all
		.filter(({ hsl: [, , l] }) => l > 0.04 && l < 0.22)
		.sort((a, b) => b.score - a.score)[0];
	return {
		primary: primary ? hex(primary.rgb) : null,
		accent: accent ? hex(accent.rgb) : null,
		dark: dark ? hex(dark.rgb) : null,
		top: vivid.slice(0, 6).map((c) => `${hex(c.rgb)}(${c.score})`),
	};
}

// ---------- Icon discovery ----------

function iconCandidates(html: string, base: string): { url: string; score: number }[] {
	const out: { url: string; score: number }[] = [];
	const abs = (u: string) => {
		try { return new URL(u, base).toString(); } catch { return null; }
	};
	for (const tag of html.match(/<link[^>]+>/gi) ?? []) {
		const rel = (attr(tag, "rel") ?? "").toLowerCase();
		const href = attr(tag, "href");
		if (!href || !/icon/.test(rel)) continue;
		const size = Number((attr(tag, "sizes") ?? "").split("x")[0]) || 0;
		const url = abs(href);
		if (!url) continue;
		let score = rel.includes("apple-touch") ? 300 : 100;
		score += Math.min(size, 512) / 2;
		if (/\.svg(\?|$)/i.test(url)) score += 150;
		if (/\.ico(\?|$)/i.test(url)) score -= 80;
		out.push({ url, score });
	}
	// Header <img> logos are usually wide wordmarks that shrink to nothing in the
	// square tile, so they're a last resort behind any real square icon.
	for (const tag of html.match(/<img[^>]+>/gi) ?? []) {
		const blob = `${attr(tag, "src") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "class") ?? ""}`;
		const src = attr(tag, "src");
		if (src && /logo/i.test(blob) && !src.startsWith("data:")) {
			const url = abs(src);
			if (url) out.push({ url, score: 20 });
		}
	}
	// The conventional square touch icon, even when no <link> advertises it.
	const fallback = abs("/apple-touch-icon.png");
	if (fallback) out.push({ url: fallback, score: 260 });
	const ico = abs("/favicon.ico");
	if (ico) out.push({ url: ico, score: 10 });
	return out.sort((a, b) => b.score - a.score);
}

async function uploadIcon(client: Client, url: string): Promise<string | null> {
	const res = await get(url);
	if (!res) return null;
	const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
	if (!type.startsWith("image/")) return null;
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length < 100 || bytes.length > 2_000_000) return null;
	const ext = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[type] ?? "ico";
	if (values["dry-run"]) return `${url} (${type}, ${bytes.length} bytes — not uploaded)`;

	const key = env("SUPABASE_SERVICE_ROLE_KEY");
	const path = `${client.id}/icon.${ext}`;
	const up = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/client-assets/${path}`, {
		method: "POST",
		headers: {
			apikey: key,
			...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
			"Content-Type": type,
			"x-upsert": "true",
			"cache-control": "3600",
		},
		body: bytes,
	});
	if (!up.ok) throw new Error(`Storage upload failed: ${up.status} ${await up.text()}`);
	return `${env("SUPABASE_URL")}/storage/v1/object/public/client-assets/${path}?v=${Date.now()}`;
}

async function main() {
	const [client] = await sb<(Client & { profile: Record<string, unknown> })[]>(
		"GET",
		`clients?select=*&slug=eq.${encodeURIComponent(values.client as string)}`,
	);
	if (!client) throw new Error(`No client "${values.client}"`);
	const site = `https://${client.domain}/`;

	const page = await get(site);
	const html = page ? await page.text() : "";
	if (!html) console.warn(`Could not fetch ${site} — colours/icon need --primary/--icon overrides.`);
	const base = page?.url ?? site;

	// Inline <style> + up to 6 linked stylesheets.
	let css = (html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
	const sheets = (html.match(/<link[^>]+>/gi) ?? [])
		.filter((t) => /stylesheet/i.test(attr(t, "rel") ?? ""))
		.map((t) => attr(t, "href"))
		.filter((h): h is string => Boolean(h))
		.slice(0, 6);
	for (const href of sheets) {
		const res = await get(new URL(href, base).toString());
		if (res) css += `\n${await res.text()}`;
	}
	const palette = pickPalette(collectColors(css, html));

	let iconUrl: string | null = null;
	let iconSource: string | null = null;
	for (const cand of values.icon ? [{ url: values.icon, score: 0 }] : iconCandidates(html, base)) {
		iconUrl = await uploadIcon(client, cand.url);
		if (iconUrl) { iconSource = cand.url; break; }
	}

	const existing = (client.profile?.branding ?? {}) as Record<string, unknown>;
	const manual = Boolean(values.primary || values.accent || values.dark);
	const branding = {
		...existing,
		primary: values.primary ?? palette.primary ?? existing.primary ?? "#3b82f6",
		accent: values.accent ?? palette.accent ?? existing.accent ?? null,
		dark: values.dark ?? palette.dark ?? existing.dark ?? null,
		icon_url: iconUrl ?? existing.icon_url ?? null,
		icon_source: iconSource ?? existing.icon_source ?? null,
		source: manual ? "manual" : "scraped",
		assumed: !manual && !palette.primary,
		scraped_at: new Date().toISOString(),
	};

	console.log(`Site: ${base}`);
	console.log(`Colour candidates: ${palette.top.join(" ") || "none"}`);
	console.log(`Picked: primary ${branding.primary}  accent ${branding.accent ?? "-"}  dark ${branding.dark ?? "-"}${branding.assumed ? "  (ASSUMED — no brand colour found)" : ""}`);
	console.log(`Icon: ${iconSource ?? "none found"}`);
	if (values["dry-run"]) return;

	await sb("PATCH", `clients?id=eq.${client.id}`, { profile: { ...client.profile, branding } }, "return=minimal");
	console.log(`Saved branding for ${client.slug}${iconUrl ? " (icon uploaded)" : ""}.`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
