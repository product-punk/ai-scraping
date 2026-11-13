// Scrape every active client's prompts once (ChatGPT via DataForSEO, plus the
// OpenAI API when enabled) and store the batch in Supabase.
//
//   node weekly-tracker/scripts/run-weekly.ts                    # all active clients
//   node weekly-tracker/scripts/run-weekly.ts --client acme      # one client
//   node weekly-tracker/scripts/run-weekly.ts --dry-run          # show plan + cost, no API calls
import { parseArgs } from "node:util";
import {
	askOpenAi,
	type Client,
	citedIn,
	namedIn,
	proseOf,
	type ScrapeResult,
	sb,
	scrapeChatGpt,
} from "./lib.ts";

const { values } = parseArgs({
	options: {
		client: { type: "string", multiple: true },
		trigger: { type: "string", default: "manual" },
		"dry-run": { type: "boolean", default: false },
	},
});

const COST = { "chatgpt-scraped": 0.004, "openai-api": 0.01 };

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		console.warn(`    retrying after: ${err instanceof Error ? err.message : String(err)}`);
		await new Promise((r) => setTimeout(r, 5000));
		return fn();
	}
}

async function storeRun(client: Client, batchId: string, prompt: string, provider: string, result: ScrapeResult) {
	const prose = proseOf(result.text);
	const brandMentioned = namedIn(prose, [client.name, ...client.aliases]);
	const brandCited = citedIn(result.citations, [client.domain]);
	const competitorsMentioned = client.competitors
		.filter((c) => namedIn(prose, [c.name, ...(c.aliases ?? [])]))
		.map((c) => c.name);
	const competitorsCited = client.competitors.filter((c) => citedIn(result.citations, c.domains)).map((c) => c.name);

	const [run] = await sb<{ id: string }[]>("POST", "runs", {
		batch_id: batchId,
		client_id: client.id,
		prompt,
		provider,
		model_version: result.modelVersion,
		location_code: provider === "chatgpt-scraped" ? client.location_code : null,
		brand_mentioned: brandMentioned,
		brand_cited: brandCited,
		competitors_mentioned: competitorsMentioned,
		competitors_cited: competitorsCited,
		web_queries: result.webQueries,
		text_content: result.text,
	});
	if (result.citations.length > 0) {
		await sb("POST", "citations", result.citations.map((c) => ({ ...c, run_id: run.id })), "return=minimal");
	}
	if (result.searchResults.length > 0) {
		await sb("POST", "search_results", result.searchResults.map((s) => ({ ...s, run_id: run.id })), "return=minimal");
	}
	return `mentioned=${brandMentioned} cited=${brandCited} competitors=[${[...new Set([...competitorsMentioned, ...competitorsCited])].join(", ")}] citations=${result.citations.length}`;
}

async function runClient(client: Client, trigger: string): Promise<number> {
	const providers = client.include_openai ? ["chatgpt-scraped", "openai-api"] : ["chatgpt-scraped"];
	const expected = client.prompts.length * providers.length;
	const [batch] = await sb<{ id: string }[]>("POST", "batches", {
		client_id: client.id,
		trigger,
		runs_expected: expected,
	});
	console.log(`\n== ${client.name} (${client.slug}) — batch ${batch.id}, ${expected} runs`);

	let failed = 0;
	for (const prompt of client.prompts) {
		for (const provider of providers) {
			process.stdout.write(`  [${provider}] ${prompt.slice(0, 70)}… `);
			try {
				const result = await withRetry(() =>
					provider === "openai-api"
						? askOpenAi(prompt)
						: scrapeChatGpt(prompt, client.location_code, client.language_code),
				);
				console.log(await storeRun(client, batch.id, prompt, provider, result));
			} catch (err) {
				failed++;
				console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	await sb(
		"PATCH",
		`batches?id=eq.${batch.id}`,
		{ finished_at: new Date().toISOString(), runs_failed: failed },
		"return=minimal",
	);
	return failed;
}

async function main() {
	// Scheduled runs obey the global switch (settings.weekly_scrape_enabled, owner-only).
	// Off → exit before any API call; clients' own switches stay saved for when it's on.
	if (values.trigger === "scheduled") {
		const [g] = await sb<{ value: boolean }[]>("GET", "settings?select=value&key=eq.weekly_scrape_enabled");
		if (g?.value !== true) {
			const waiting = await sb<{ slug: string }[]>("GET", "clients?select=slug&active=eq.true");
			console.log(`Weekly scraping is switched off globally; nothing scraped.${waiting.length ? ` Waiting for it to be switched on: ${waiting.map((c) => c.slug).join(", ")}.` : ""}`);
			return;
		}
	}
	// No --client: the Monday set (clients switched on). Named clients run regardless
	// of their weekly switch, so a one-off manual scrape works for anyone.
	let query = "clients?select=*&order=name";
	query += values.client?.length
		? `&slug=in.(${values.client.map(encodeURIComponent).join(",")})`
		: "&active=eq.true";
	const clients = await sb<Client[]>("GET", query);
	if (clients.length === 0) {
		console.log("No matching active clients.");
		return;
	}

	let cost = 0;
	for (const c of clients) {
		cost += c.prompts.length * (COST["chatgpt-scraped"] + (c.include_openai ? COST["openai-api"] : 0));
	}
	console.log(`Clients: ${clients.map((c) => `${c.slug} (${c.prompts.length} prompts)`).join(", ")}`);
	console.log(`Estimated cost: ~$${cost.toFixed(2)}`);
	if (values["dry-run"]) return;

	let failures = 0;
	for (const c of clients) failures += await runClient(c, values.trigger as string);
	console.log(failures ? `\n${failures} run(s) failed.` : "\nAll runs succeeded.");
	if (failures) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
