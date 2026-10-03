/**
 * Ad-hoc scrape runner: run one or more prompts against one or more providers,
 * persist each result to the local DB exactly as the worker does (prompt_runs +
 * citations), and write a combined CSV snapshot. Brand/prompt/competitors are
 * upserted so repeated runs accumulate history under the same brand — which is
 * what makes the eventual handoff to the always-on worker seamless.
 *
 * By default it scrapes via DataForSEO. Add --openai to ALSO call the OpenAI API
 * (gpt-5-mini) per prompt, giving a scraped-ChatGPT vs direct-API-ChatGPT compare.
 *
 *   pnpm exec tsx scripts/run-scrape.ts \
 *     --brand "Luke's Lobster" --website lukeslobster.com \
 *     --prompt "Best lobster seller in US" \
 *     --competitor "LobsterAnywhere:lobsteranywhere.com" \
 *     --openai
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Provider } from "../src/providers";

// Load env before importing anything that reads DATABASE_URL at module load.
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
	for (const rel of ["../../../.env", "../../../apps/web/.env"]) {
		try {
			process.loadEnvFile(path.resolve(here, rel));
			break;
		} catch {
			// try next candidate
		}
	}
}

type ScrapeResult = Awaited<ReturnType<Provider["run"]>>;
type Db = typeof import("../src/db/db")["db"];
type Schema = typeof import("../src/db/schema");
type AnalyzeMentions = typeof import("../src/mentions")["analyzeMentions"];
type GetProvider = typeof import("../src/providers")["getProvider"];
type CompetitorRows = Parameters<AnalyzeMentions>[2];
type Mentions = { brandMentioned: boolean; competitorsMentioned: string[] };

interface Target {
	provider: string;
	model: string;
	locationCode?: number;
	languageCode?: string;
}

// DataForSEO models where a location_code genuinely localizes results. The LLM
// surfaces (chatgpt/gemini/perplexity) are intentionally excluded — DataForSEO
// does not reliably honor geo there (see providers/registry/dataforseo.ts).
const GEO_CAPABLE_MODELS = new Set(["google-ai-mode", "google-ai-overview"]);

interface Deps {
	db: Db;
	schema: Schema;
	analyzeMentions: AnalyzeMentions;
	getProvider: GetProvider;
	eq: typeof import("drizzle-orm")["eq"];
	and: typeof import("drizzle-orm")["and"];
}

interface Config {
	brandName: string;
	website: string;
	orgId: string;
	webSearch: boolean;
	brandAliases: string[];
	competitorSpecs: { name: string; domains: string[] }[];
	promptValues: string[];
	targets: Target[];
	brandId: string;
	csv: string | undefined;
}

const CSV_HEADER = [
	"prompt",
	"model",
	"provider",
	"version",
	"webSearchEnabled",
	"location",
	"brandMentioned",
	"competitorsMentioned",
	"webQueries",
	"citationIndex",
	"domain",
	"title",
	"url",
	"textContent",
];

// Companion CSV: the sites the fan-out/web searches actually surfaced
// (DataForSEO `search_results`), which is broader than the cited `sources`.
const SEARCH_RESULTS_HEADER = [
	"prompt",
	"model",
	"provider",
	"location",
	"resultIndex",
	"domain",
	"title",
	"url",
	"description",
];

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function csvCell(value: unknown): string {
	const s = value == null ? "" : String(value);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCompetitor(c: string): { name: string; domains: string[] } {
	const idx = c.indexOf(":");
	return idx === -1
		? { name: c.trim(), domains: [] }
		: { name: c.slice(0, idx).trim(), domains: [c.slice(idx + 1).trim()].filter(Boolean) };
}

function parseInputs(): Config {
	const { values } = parseArgs({
		options: {
			brand: { type: "string" },
			website: { type: "string" },
			prompt: { type: "string", multiple: true },
			competitor: { type: "string", multiple: true },
			aliases: { type: "string" },
			model: { type: "string", default: "chatgpt" },
			openai: { type: "boolean", default: false },
			"openai-only": { type: "boolean", default: false },
			"openai-model": { type: "string", default: "gpt-5-mini" },
			location: { type: "string", multiple: true },
			language: { type: "string", default: "en" },
			org: { type: "string", default: "org_adhoc" },
			csv: { type: "string" },
			"no-web-search": { type: "boolean", default: false },
		},
	});

	const promptValues = (values.prompt ?? []).map((p) => p.trim()).filter(Boolean);
	const missing = [
		["brand", values.brand],
		["website", values.website],
		["prompt", promptValues.length > 0 ? "ok" : ""],
	]
		.filter(([, v]) => !v)
		.map(([k]) => k);
	if (missing.length > 0) {
		console.error(`Missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
		console.error(
			'Usage: tsx scripts/run-scrape.ts --brand "Name" --website domain.com --prompt "..." [--prompt "..."]... [--competitor "Name:domain.com"]... [--aliases "a,b"] [--model chatgpt|google-ai-overview|google-ai-mode] [--location 2840]... [--language en] [--openai] [--openai-model gpt-5-mini] [--csv out.csv] [--no-web-search]',
		);
		process.exit(1);
	}

	const brandName = values.brand as string;
	return {
		brandName,
		website: values.website as string,
		orgId: values.org as string,
		webSearch: !values["no-web-search"],
		brandAliases: (values.aliases ?? "")
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean),
		competitorSpecs: (values.competitor ?? []).map(parseCompetitor),
		promptValues,
		targets: buildTargets({
			model: values.model as string,
			language: values.language as string,
			locations: values.location ?? [],
			openai: values.openai ?? false,
			openaiOnly: values["openai-only"] ?? false,
			openaiModel: values["openai-model"] as string,
		}),
		brandId: `brand_${slugify(brandName)}`,
		csv: values.csv,
	};
}

/**
 * Build the provider targets. Geo only applies to the reliable Google surfaces:
 * a geo-capable model with locations yields one target per location, otherwise a
 * single target. --openai adds a direct OpenAI API target (never geo-located).
 * --openai-only skips the DataForSEO target entirely (useful to backfill the
 * direct-API run after a transient OpenAI failure without re-spending scrape credits).
 */
function buildTargets(input: {
	model: string;
	language: string;
	locations: string[];
	openai: boolean;
	openaiOnly: boolean;
	openaiModel: string;
}): Target[] {
	const { model, language } = input;
	const locationCodes = input.locations.map((l) => Number(l)).filter((n) => Number.isFinite(n));
	const geoCapable = GEO_CAPABLE_MODELS.has(model);

	if (input.openaiOnly) {
		return [{ provider: "openai-api", model: input.openaiModel }];
	}

	const targets: Target[] = [];
	if (geoCapable && locationCodes.length > 0) {
		for (const code of locationCodes) {
			targets.push({ provider: "dataforseo", model, locationCode: code, languageCode: language });
		}
	} else {
		if (locationCodes.length > 0) {
			console.warn(
				`--location ignored for model "${model}": geo is only supported for ${[...GEO_CAPABLE_MODELS].join(", ")}.`,
			);
		}
		targets.push({ provider: "dataforseo", model, languageCode: geoCapable ? language : undefined });
	}
	if (input.openai) {
		targets.push({ provider: "openai-api", model: input.openaiModel });
	}
	return targets;
}

/** Upsert org + brand + competitors once, then return the brand's competitor rows. */
async function upsertBrandContext(deps: Deps, cfg: Config): Promise<CompetitorRows> {
	const { db, schema, and, eq } = deps;
	await db
		.insert(schema.organization)
		.values({ id: cfg.orgId, name: "Ad-hoc", slug: cfg.orgId, createdAt: new Date() })
		.onConflictDoNothing();

	await db
		.insert(schema.brands)
		.values({
			id: cfg.brandId,
			name: cfg.brandName,
			website: cfg.website,
			aliases: cfg.brandAliases,
			organizationId: cfg.orgId,
		})
		.onConflictDoUpdate({
			target: schema.brands.id,
			set: { name: cfg.brandName, website: cfg.website, aliases: cfg.brandAliases },
		});

	for (const spec of cfg.competitorSpecs) {
		const existing = await db
			.select({ id: schema.competitors.id })
			.from(schema.competitors)
			.where(and(eq(schema.competitors.brandId, cfg.brandId), eq(schema.competitors.name, spec.name)));
		if (existing.length === 0) {
			await db.insert(schema.competitors).values({ brandId: cfg.brandId, name: spec.name, domains: spec.domains });
		}
	}
	return db.select().from(schema.competitors).where(eq(schema.competitors.brandId, cfg.brandId));
}

/** Find-or-create the prompt row, returning its id. */
async function upsertPrompt(deps: Deps, cfg: Config, promptValue: string): Promise<string> {
	const { db, schema, and, eq } = deps;
	const [existing] = await db
		.select({ id: schema.prompts.id })
		.from(schema.prompts)
		.where(and(eq(schema.prompts.brandId, cfg.brandId), eq(schema.prompts.value, promptValue)));
	if (existing) return existing.id;
	const [created] = await db
		.insert(schema.prompts)
		.values({ brandId: cfg.brandId, value: promptValue })
		.returning({ id: schema.prompts.id });
	return created.id;
}

/** Run one prompt against one target, retrying once on the transient "No response or tasks" hiccup. */
async function runWithRetry(
	provider: Provider,
	target: Target,
	prompt: string,
	webSearch: boolean,
): Promise<ScrapeResult> {
	const options = { webSearch, locationCode: target.locationCode, languageCode: target.languageCode };
	try {
		return await provider.run(target.model, prompt, options);
	} catch (err) {
		console.warn(`  retrying after: ${err instanceof Error ? err.message : String(err)}`);
		return provider.run(target.model, prompt, options);
	}
}

function csvRowsForResult(
	cfg: Config,
	promptValue: string,
	target: Target,
	result: ScrapeResult,
	mentions: Mentions,
): string[][] {
	const scalar = [
		promptValue,
		target.model,
		target.provider,
		result.modelVersion ?? target.model,
		cfg.webSearch,
		target.locationCode ?? "",
		mentions.brandMentioned,
		mentions.competitorsMentioned.join("; "),
		result.webQueries.join("; "),
	].map(String);
	if (result.citations.length === 0) {
		return [[...scalar, "", "", "", "", result.textContent ?? ""]];
	}
	return result.citations.map((c, i) => [
		...scalar,
		String(c.citationIndex),
		c.domain,
		c.title ?? "",
		c.url,
		i === 0 ? (result.textContent ?? "") : "",
	]);
}

/** DataForSEO exposes the pages its web search surfaced in `search_results` — broader than cited sources. */
function searchResultRows(promptValue: string, target: Target, result: ScrapeResult): string[][] {
	const raw = result.rawOutput as { tasks?: { result?: { search_results?: unknown }[] }[] } | undefined;
	const results = raw?.tasks?.[0]?.result?.[0]?.search_results;
	if (!Array.isArray(results)) return [];
	return results.map((s, i) => {
		const o = (s ?? {}) as { url?: string; domain?: string; title?: string; description?: string };
		return [
			promptValue,
			target.model,
			target.provider,
			String(target.locationCode ?? ""),
			String(i),
			o.domain ?? "",
			o.title ?? "",
			o.url ?? "",
			o.description ?? "",
		];
	});
}

/** Scrape one prompt with one target, persist run + citations, return CSV rows + a summary line. */
async function runTarget(
	deps: Deps,
	cfg: Config,
	compRows: CompetitorRows,
	promptValue: string,
	promptId: string,
	target: Target,
): Promise<{ rows: string[][]; searchRows: string[][]; summary: string; ok: boolean }> {
	const { db, schema, analyzeMentions } = deps;
	const geo = target.locationCode ? `, location=${target.locationCode}` : "";
	console.log(`\n[${target.provider}] "${promptValue}" (model=${target.model}, webSearch=${cfg.webSearch}${geo})...`);

	let result: ScrapeResult;
	try {
		result = await runWithRetry(deps.getProvider(target.provider), target, promptValue, cfg.webSearch);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`  FAILED: ${msg}`);
		return { rows: [], searchRows: [], summary: `✗ [${target.provider}] "${promptValue}" — ${msg}`, ok: false };
	}

	const mentions = analyzeMentions(
		typeof result.textContent === "string" ? result.textContent : "",
		{ name: cfg.brandName, aliases: cfg.brandAliases, domains: [cfg.website] },
		compRows,
	);

	const [run] = await db
		.insert(schema.promptRuns)
		.values({
			promptId,
			brandId: cfg.brandId,
			model: target.model,
			provider: target.provider,
			version: result.modelVersion ?? target.model,
			webSearchEnabled: cfg.webSearch,
			rawOutput: result.rawOutput,
			webQueries: result.webQueries,
			brandMentioned: mentions.brandMentioned,
			competitorsMentioned: mentions.competitorsMentioned,
		})
		.returning({ id: schema.promptRuns.id, createdAt: schema.promptRuns.createdAt });

	if (result.citations.length > 0) {
		await db.insert(schema.citations).values(
			result.citations.map((c) => ({
				promptRunId: run.id,
				promptId,
				brandId: cfg.brandId,
				model: target.model,
				url: c.url,
				domain: c.domain,
				title: c.title || null,
				citationIndex: c.citationIndex,
				createdAt: run.createdAt,
			})),
		);
	}

	const searchRows = searchResultRows(promptValue, target, result);
	return {
		rows: csvRowsForResult(cfg, promptValue, target, result, mentions),
		searchRows,
		summary: `✓ [${target.provider}] "${promptValue}" — run ${run.id} | brand=${mentions.brandMentioned} competitors=[${mentions.competitorsMentioned.join(", ")}] citations=${result.citations.length} searchResults=${searchRows.length}`,
		ok: true,
	};
}

async function main() {
	const cfg = parseInputs();

	const { and, eq } = await import("drizzle-orm");
	const { db } = await import("../src/db/db");
	const schema = await import("../src/db/schema");
	const { analyzeMentions } = await import("../src/mentions");
	const { getProvider } = await import("../src/providers");
	const deps: Deps = { db, schema, analyzeMentions, getProvider, and, eq };

	const compRows = await upsertBrandContext(deps, cfg);

	const csvRows: string[][] = [];
	const searchRows: string[][] = [];
	const summaries: string[] = [];
	let failures = 0;
	let total = 0;
	for (const promptValue of cfg.promptValues) {
		const promptId = await upsertPrompt(deps, cfg, promptValue);
		for (const target of cfg.targets) {
			total++;
			const result = await runTarget(deps, cfg, compRows, promptValue, promptId, target);
			csvRows.push(...result.rows);
			searchRows.push(...result.searchRows);
			summaries.push(result.summary);
			if (!result.ok) failures++;
		}
	}

	const csvPath = cfg.csv ?? path.resolve(process.cwd(), `scrape-${slugify(cfg.brandName)}-${Date.now()}.csv`);
	writeFileSync(csvPath, `${[CSV_HEADER, ...csvRows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`);

	// Companion CSV of the sites the searches surfaced (only when any were returned).
	let searchCsvPath: string | undefined;
	if (searchRows.length > 0) {
		searchCsvPath = `${csvPath.replace(/\.csv$/i, "")}-search-results.csv`;
		writeFileSync(
			searchCsvPath,
			`${[SEARCH_RESULTS_HEADER, ...searchRows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`,
		);
	}

	console.log(`\n===== Summary (brand ${cfg.brandId}) =====`);
	for (const line of summaries) console.log(`  ${line}`);
	console.log(`CSV: ${csvPath}`);
	if (searchCsvPath) console.log(`Search results CSV: ${searchCsvPath}`);
	if (failures > 0) {
		console.error(`\n${failures}/${total} run(s) failed.`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
