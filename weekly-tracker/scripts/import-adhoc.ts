// One-way import of an ad-hoc scrape (elmo/scrapes/*.csv from run-scrape.ts) into
// the tracker as a dated batch. Reads the files only; the ad-hoc tooling is untouched.
// Named/cited are recomputed from the answer text and citations with the tracker's rules.
//
//   node weekly-tracker/scripts/import-adhoc.ts --client scaler \
//     --csv elmo/scrapes/scaler-fde-chatgpt-india-complete.csv --date 2026-10-11 [--dry-run]
// The companion "<name>-search-results.csv" is picked up automatically if present.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Client, citedIn, namedIn, proseOf, sb, toCitation } from "./lib.ts";

const { values } = parseArgs({
	options: {
		client: { type: "string" },
		csv: { type: "string" },
		date: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});
if (!values.client || !values.csv || !values.date || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
	console.error("Usage: import-adhoc.ts --client <slug> --csv <file.csv> --date YYYY-MM-DD [--dry-run]");
	process.exit(1);
}

function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [], cell = "", q = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (q) {
			if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
			else if (ch === '"') q = false;
			else cell += ch;
		} else if (ch === '"') q = true;
		else if (ch === ",") { row.push(cell); cell = ""; }
		else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
		else cell += ch;
	}
	if (cell || row.length) { row.push(cell); rows.push(row); }
	const [header, ...body] = rows.filter((r) => r.length > 1);
	return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// Ad-hoc provider names → tracker provider names.
const PROVIDER: Record<string, string> = { dataforseo: "chatgpt-scraped", "openai-api": "openai-api" };

async function main() {
	const [client] = await sb<Client[]>("GET", `clients?select=*&slug=eq.${encodeURIComponent(values.client as string)}`);
	if (!client) throw new Error(`No client "${values.client}" — add it with client.ts upsert first`);

	const rows = parseCsv(readFileSync(values.csv as string, "utf8"));
	const searchPath = (values.csv as string).replace(/\.csv$/i, "-search-results.csv");
	const searchRows = existsSync(searchPath) ? parseCsv(readFileSync(searchPath, "utf8")) : [];

	// Group citation-grain rows into runs keyed by prompt × provider.
	type Draft = { prompt: string; provider: string; version: string; location: string; text: string; cites: { url: string; title: string; idx: number }[] };
	const runs = new Map<string, Draft>();
	for (const r of rows) {
		const provider = PROVIDER[r.provider];
		if (!provider) continue;
		const key = `${r.prompt}|${provider}`;
		const d = runs.get(key) ?? { prompt: r.prompt, provider, version: r.version, location: r.location, text: "", cites: [] };
		if (r.textContent && !d.text) d.text = r.textContent;
		if (r.url) d.cites.push({ url: r.url, title: r.title, idx: Number(r.citationIndex) || d.cites.length });
		runs.set(key, d);
	}
	const fanByPrompt = new Map<string, Record<string, string>[]>();
	for (const s of searchRows) {
		if (s.provider !== "dataforseo") continue;
		(fanByPrompt.get(s.prompt) ?? fanByPrompt.set(s.prompt, []).get(s.prompt))!.push(s);
	}

	const unknown = [...runs.values()].filter((d) => !client.prompts.includes(d.prompt));
	console.log(`${runs.size} runs (${[...new Set([...runs.values()].map((d) => d.provider))].join(", ")}), ${searchRows.length} fan-out rows, batch date ${values.date}`);
	if (unknown.length) console.warn(`  ${unknown.length} run(s) use prompts not in the client's prompt list (imported anyway).`);
	if (values["dry-run"]) return;

	const startedAt = `${values.date}T06:00:00Z`;
	const [batch] = await sb<{ id: string }[]>("POST", "batches", {
		client_id: client.id,
		trigger: "import",
		started_at: startedAt,
		finished_at: startedAt,
		runs_expected: runs.size,
	});

	let named = 0, cited = 0;
	for (const d of runs.values()) {
		const citations = d.cites
			.sort((a, b) => a.idx - b.idx)
			.map((c, i) => toCitation(c.url, c.title, i))
			.filter((c): c is NonNullable<typeof c> => c !== null);
		const prose = proseOf(d.text);
		const brandMentioned = namedIn(prose, [client.name, ...client.aliases]);
		const brandCited = citedIn(citations, [client.domain]);
		named += Number(brandMentioned);
		cited += Number(brandCited);
		const [run] = await sb<{ id: string }[]>("POST", "runs", {
			batch_id: batch.id,
			client_id: client.id,
			prompt: d.prompt,
			provider: d.provider,
			model_version: d.version || null,
			location_code: d.provider === "chatgpt-scraped" && d.location ? Number(d.location) : null,
			brand_mentioned: brandMentioned,
			brand_cited: brandCited,
			competitors_mentioned: client.competitors.filter((c) => namedIn(prose, [c.name, ...(c.aliases ?? [])])).map((c) => c.name),
			competitors_cited: client.competitors.filter((c) => citedIn(citations, c.domains)).map((c) => c.name),
			web_queries: [],
			text_content: d.text,
			created_at: startedAt,
		});
		if (citations.length) await sb("POST", "citations", citations.map((c) => ({ ...c, run_id: run.id })), "return=minimal");
		const fan = d.provider === "chatgpt-scraped" ? fanByPrompt.get(d.prompt) ?? [] : [];
		if (fan.length) {
			await sb("POST", "search_results", fan.map((s, i) => ({
				run_id: run.id,
				position: Number(s.resultIndex) || i,
				url: s.url || null,
				domain: s.domain ? s.domain.replace(/^www\./, "") : null,
				title: s.title || null,
				description: s.description || null,
			})), "return=minimal");
		}
	}
	console.log(`Imported batch ${batch.id}: ${runs.size} runs, named in ${named}, cited in ${cited}.`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
