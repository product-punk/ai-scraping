// Shared helpers for the weekly tracker. Zero dependencies: Node 24 runs this
// TypeScript directly (type stripping), so CI needs no install step.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRACKER_ROOT = path.resolve(here, "..");

// Locally, read weekly-tracker/.env; in CI the variables come from secrets.
try {
	process.loadEnvFile(path.join(TRACKER_ROOT, ".env"));
} catch {
	// no local .env — fine in CI
}

export function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing environment variable ${name}`);
	return value;
}

// ---------- Types ----------

export interface Competitor {
	name: string;
	domains: string[];
	aliases?: string[];
}

export interface Client {
	id: string;
	slug: string;
	name: string;
	domain: string;
	aliases: string[];
	competitors: Competitor[];
	prompts: string[];
	location_code: number;
	language_code: string;
	include_openai: boolean;
	active: boolean;
	share_token: string;
}

export interface Citation {
	position: number;
	url: string;
	domain: string;
	title: string | null;
}

export interface SearchResult {
	position: number;
	url: string | null;
	domain: string | null;
	title: string | null;
	description: string | null;
}

export interface ScrapeResult {
	text: string;
	citations: Citation[];
	searchResults: SearchResult[];
	webQueries: string[];
	modelVersion: string;
}

// ---------- Supabase (PostgREST over fetch) ----------

function supabaseHeaders(): Record<string, string> {
	const key = env("SUPABASE_SERVICE_ROLE_KEY");
	const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
	// Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys must not.
	if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
	return headers;
}

export async function sb<T = unknown>(
	method: "GET" | "POST" | "PATCH" | "DELETE",
	pathAndQuery: string,
	body?: unknown,
	prefer = "return=representation",
): Promise<T> {
	const url = `${env("SUPABASE_URL").replace(/\/$/, "")}/rest/v1/${pathAndQuery}`;
	const res = await fetch(url, {
		method,
		headers: { ...supabaseHeaders(), Prefer: prefer },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery} → ${res.status}: ${text}`);
	return (text ? JSON.parse(text) : null) as T;
}

// ---------- Citations ----------

export function toCitation(url: unknown, title: unknown, position: number): Citation | null {
	if (typeof url !== "string" || !url.startsWith("http")) return null;
	try {
		const domain = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
		return { position, url, domain, title: typeof title === "string" && title.trim() ? title.trim() : null };
	} catch {
		return null;
	}
}

function dedupeCitations(raw: { url: unknown; title: unknown }[]): Citation[] {
	const seen = new Set<string>();
	const out: Citation[] = [];
	for (const { url, title } of raw) {
		if (typeof url !== "string" || seen.has(url)) continue;
		const c = toCitation(url, title, out.length);
		if (c) {
			seen.add(url);
			out.push(c);
		}
	}
	return out;
}

// ---------- DataForSEO: scraped ChatGPT (what a real user sees) ----------

export async function scrapeChatGpt(prompt: string, locationCode: number, languageCode: string): Promise<ScrapeResult> {
	if (prompt.length > 500) throw new Error("Prompt longer than 500 characters (DataForSEO limit)");
	const auth = Buffer.from(`${env("DATAFORSEO_LOGIN")}:${env("DATAFORSEO_PASSWORD")}`).toString("base64");
	const res = await fetch("https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced", {
		method: "POST",
		headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
		body: JSON.stringify([
			{ keyword: prompt, location_code: locationCode, language_code: languageCode, force_web_search: true },
		]),
		signal: AbortSignal.timeout(300_000),
	});
	const json = (await res.json()) as any;
	const task = json?.tasks?.[0];
	if (!res.ok || json?.status_code !== 20000 || task?.status_code !== 20000) {
		throw new Error(`DataForSEO error: ${task?.status_message ?? json?.status_message ?? res.status}`);
	}
	const result = task?.result?.[0];
	if (!result) throw new Error("DataForSEO returned no result");

	let text: string = typeof result.markdown === "string" ? result.markdown : "";
	if (!text.trim()) {
		text = (result.items ?? [])
			.map((i: any) => (typeof i?.markdown === "string" ? i.markdown.trim() : ""))
			.filter(Boolean)
			.join("\n\n");
	}
	const sources = [
		...(Array.isArray(result.sources) ? result.sources : []),
		...(Array.isArray(result.items) ? result.items : []).flatMap((i: any) => (Array.isArray(i?.sources) ? i.sources : [])),
	];
	const searchResults: SearchResult[] = (Array.isArray(result.search_results) ? result.search_results : []).map(
		(s: any, i: number) => ({
			position: i,
			url: s?.url ?? null,
			domain: s?.domain ? String(s.domain).replace(/^www\./, "") : null,
			title: s?.title ?? null,
			description: s?.description ?? null,
		}),
	);
	return {
		text,
		citations: dedupeCitations(sources.map((s: any) => ({ url: s?.url, title: s?.title }))),
		searchResults,
		webQueries: [], // ChatGPT's scraper doesn't expose the fan-out query strings
		modelVersion: result.model ?? "chatgpt",
	};
}

// ---------- OpenAI API directly (the raw model, with web search) ----------

export async function askOpenAi(prompt: string, model = "gpt-5-mini"): Promise<ScrapeResult> {
	const res = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			input: prompt,
			tools: [{ type: "web_search", search_context_size: "low" }],
			tool_choice: "auto",
			max_tool_calls: 2,
			max_output_tokens: 8000,
		}),
		signal: AbortSignal.timeout(300_000),
	});
	const json = (await res.json()) as any;
	if (!res.ok) throw new Error(`OpenAI error: ${json?.error?.message ?? res.status}`);

	const output: any[] = Array.isArray(json.output) ? json.output : [];
	const texts: string[] = [];
	const annotations: { url: unknown; title: unknown }[] = [];
	const webQueries: string[] = [];
	for (const item of output) {
		if (item?.type === "message") {
			for (const part of item.content ?? []) {
				if (part?.type === "output_text") {
					texts.push(part.text ?? "");
					for (const a of part.annotations ?? []) {
						if (a?.type === "url_citation") annotations.push({ url: a.url, title: a.title });
					}
				}
			}
		} else if (item?.type === "web_search_call" && item.action?.type === "search") {
			for (const q of [item.action.query, ...(item.action.queries ?? [])]) {
				if (typeof q === "string" && q.trim() && !webQueries.includes(q)) webQueries.push(q);
			}
		}
	}
	return {
		text: texts.join("\n"),
		citations: dedupeCitations(annotations),
		searchResults: [],
		webQueries,
		modelVersion: json.model ?? model,
	};
}

// ---------- Mention / citation detection ----------

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Answer prose with markdown link targets and bare URLs removed, lowercased. */
export function proseOf(text: string): string {
	return text
		.replace(/\]\([^)]*\)/g, "]")
		.replace(/https?:\/\/\S+/g, " ")
		.toLowerCase();
}

/** Word-bounded, case-insensitive name match ("HUB International" won't match "hubinternational.com"). */
export function namedIn(prose: string, names: string[]): boolean {
	return names.some((n) => {
		const name = n.trim().toLowerCase();
		return name && new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}($|[^a-z0-9])`).test(prose);
	});
}

export function citedIn(citations: Citation[], domains: string[]): boolean {
	const wanted = domains.map((d) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase());
	return citations.some((c) => wanted.some((d) => d && (c.domain === d || c.domain.endsWith(`.${d}`))));
}
