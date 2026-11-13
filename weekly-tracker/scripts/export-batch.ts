// Export a client's recent batches in the aeo-data-analysis input format
// (DataForSEO / OpenAI / Fan-Out sheets as CSVs, + run_date) plus a context.json
// with the client profile, prompt tags and previous insight snapshots.
//
//   node weekly-tracker/scripts/export-batch.ts --client acme            # latest + previous batch
//   node weekly-tracker/scripts/export-batch.ts --client acme --weeks 6  # last 6 batches (trend)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Client, sb, TRACKER_ROOT } from "./lib.ts";

const { values } = parseArgs({
	options: {
		client: { type: "string" },
		weeks: { type: "string", default: "2" },
		out: { type: "string" },
	},
});
if (!values.client) {
	console.error("Usage: export-batch.ts --client <slug> [--weeks 2] [--out dir]");
	process.exit(1);
}

interface Batch { id: string; started_at: string; trigger: string; runs_expected: number; runs_failed: number }
interface Run {
	id: string; batch_id: string; prompt: string; provider: string; model_version: string | null;
	location_code: number | null; brand_mentioned: boolean; brand_cited: boolean;
	competitors_mentioned: string[]; competitors_cited: string[]; web_queries: string[]; text_content: string | null;
	citations: { position: number; url: string; domain: string; title: string | null }[];
	search_results: { position: number; url: string | null; domain: string | null; title: string | null; description: string | null }[];
}

const RESULT_HEADER = [
	"run_date", "prompt", "model", "provider", "version", "webSearchEnabled", "location", "brandMentioned",
	"brandCited", "competitorsMentioned", "competitorsCited", "webQueries", "citationIndex", "domain", "title", "url", "textContent",
];
const FANOUT_HEADER = ["run_date", "prompt", "model", "provider", "location", "resultIndex", "domain", "title", "url", "description"];
// The skill keys sources off Elmo's provider names.
const PROVIDER_OUT: Record<string, string> = { "chatgpt-scraped": "dataforseo", "openai-api": "openai-api" };

const cell = (v: unknown) => {
	const s = v == null ? "" : String(v);
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]) => `${[header, ...rows].map((r) => r.map(cell).join(",")).join("\n")}\n`;

async function main() {
	const [client] = await sb<(Client & { profile: unknown; prompt_tags: unknown })[]>(
		"GET",
		`clients?select=*&slug=eq.${encodeURIComponent(values.client as string)}`,
	);
	if (!client) throw new Error(`No client "${values.client}"`);

	const batches = await sb<Batch[]>(
		"GET",
		`batches?select=*&client_id=eq.${client.id}&finished_at=not.is.null&order=started_at.desc&limit=${Number(values.weeks) || 2}`,
	);
	if (batches.length === 0) throw new Error(`No finished batches for ${client.slug} yet`);
	const latest = batches[0];
	const dateOf = (b: Batch) => b.started_at.slice(0, 10);
	const batchDate = new Map(batches.map((b) => [b.id, dateOf(b)]));

	const runs = await sb<Run[]>(
		"GET",
		`runs?select=*,citations(position,url,domain,title),search_results(position,url,domain,title,description)&batch_id=in.(${batches.map((b) => b.id).join(",")})&order=created_at`,
	);

	const results: Record<string, unknown[][]> = { dataforseo: [], "openai-api": [] };
	const fanout: unknown[][] = [];
	for (const r of runs) {
		const provider = PROVIDER_OUT[r.provider] ?? r.provider;
		const runDate = batchDate.get(r.batch_id);
		const scalar = [
			runDate, r.prompt, "chatgpt", provider, r.model_version ?? "", true, r.location_code ?? "",
			r.brand_mentioned, r.brand_cited, r.competitors_mentioned.join("; "), r.competitors_cited.join("; "),
			r.web_queries.length ? r.web_queries.join("; ") : provider === "dataforseo" ? "unavailable" : "",
		];
		const cites = [...r.citations].sort((a, b) => a.position - b.position);
		const rows = cites.length
			? cites.map((c, i) => [...scalar, c.position, c.domain, c.title ?? "", c.url, i === 0 ? (r.text_content ?? "") : ""])
			: [[...scalar, "", "", "", "", r.text_content ?? ""]];
		(results[provider] ??= []).push(...rows);
		for (const s of [...r.search_results].sort((a, b) => a.position - b.position)) {
			fanout.push([runDate, r.prompt, "chatgpt", provider, r.location_code ?? "", s.position, s.domain ?? "", s.title ?? "", s.url ?? "", s.description ?? ""]);
		}
	}

	const outDir = values.out ?? path.join(TRACKER_ROOT, "exports", client.slug, dateOf(latest));
	mkdirSync(outDir, { recursive: true });
	const base = path.join(outDir, `${client.slug}-${dateOf(latest)}`);
	writeFileSync(`${base}-DataForSEO.csv`, toCsv(RESULT_HEADER, results.dataforseo));
	if (results["openai-api"].length) writeFileSync(`${base}-OpenAI.csv`, toCsv(RESULT_HEADER, results["openai-api"]));
	writeFileSync(`${base}-Fan-Out.csv`, toCsv(FANOUT_HEADER, fanout));

	const priorInsights = await sb<{ batch_id: string; headline: string; content: { metrics?: unknown } }[]>(
		"GET",
		`insights?select=batch_id,headline,content,created_at&client_id=eq.${client.id}&status=eq.published&order=created_at.desc&limit=12`,
	);
	writeFileSync(
		`${base}-context.json`,
		`${JSON.stringify(
			{
				client: {
					slug: client.slug, name: client.name, domain: client.domain, aliases: client.aliases,
					location_code: client.location_code, competitors: client.competitors,
					profile: client.profile, prompt_tags: client.prompt_tags, prompts: client.prompts,
				},
				latest_batch: { id: latest.id, run_date: dateOf(latest), runs_failed: latest.runs_failed },
				previous_batch: batches[1] ? { id: batches[1].id, run_date: dateOf(batches[1]) } : null,
				batches_exported: batches.map((b) => ({ id: b.id, run_date: dateOf(b), trigger: b.trigger })),
				// Earlier weeks' saved metrics, newest first — the skill's "Snapshots" for trends.
				previous_snapshots: priorInsights
					.filter((i) => i.batch_id !== latest.id)
					.map((i) => ({ run_date: batchDate.get(i.batch_id) ?? null, batch_id: i.batch_id, metrics: i.content?.metrics ?? null })),
			},
			null,
			2,
		)}\n`,
	);

	console.log(`Exported ${runs.length} runs from ${batches.length} batch(es) → ${outDir}`);
	console.log(`Latest batch ${latest.id} (${dateOf(latest)})${batches[1] ? `, previous ${batches[1].id} (${dateOf(batches[1])})` : ", no previous batch"}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
