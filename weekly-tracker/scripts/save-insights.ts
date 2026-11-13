// Store the aeo-data-analysis output for one client's batch in Supabase, where the
// dashboard picks it up. Re-saving the same batch replaces its insight.
//
//   node weekly-tracker/scripts/save-insights.ts --client acme --file insights.json [--draft]
//
// insights.json:
// {
//   "batch_id": "<uuid>",                  // the week analysed (from the export's context.json)
//   "previous_batch_id": "<uuid>|null",
//   "headline": "One sentence for the top of the dashboard",
//   "summary": "2-4 sentences",
//   "metrics": { "overall": {...}, "by_source": {...}, "by_offering": [...] },
//   "findings": ["..."],
//   "actions": [{ "priority": 1, "title": "...", "detail": "..." }],
//   "competitors": [{ "name": "...", "note": "..." }],
//   "outreach": [{ "domain": "...", "tier": "P1", "url": "...", "angle": "...", "gap": "..." }],
//   "report_file": "acme-2026-11-16-commercial.xlsx"
// }
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sb } from "./lib.ts";

const { values } = parseArgs({
	options: { client: { type: "string" }, file: { type: "string" }, draft: { type: "boolean", default: false } },
});
if (!values.client || !values.file) {
	console.error("Usage: save-insights.ts --client <slug> --file <insights.json> [--draft]");
	process.exit(1);
}

async function main() {
	const data = JSON.parse(readFileSync(values.file as string, "utf8"));
	if (!data.batch_id || !data.headline) throw new Error("insights.json needs at least batch_id and headline");

	const [client] = await sb<{ id: string }[]>("GET", `clients?select=id&slug=eq.${encodeURIComponent(values.client as string)}`);
	if (!client) throw new Error(`No client "${values.client}"`);
	const [batch] = await sb<{ id: string }[]>("GET", `batches?select=id&id=eq.${data.batch_id}&client_id=eq.${client.id}`);
	if (!batch) throw new Error(`Batch ${data.batch_id} does not belong to ${values.client}`);

	const status = values.draft ? "draft" : "published";
	const { batch_id, previous_batch_id, headline, summary, report_file, ...rest } = data;
	const content = {
		metrics: rest.metrics ?? {},
		findings: rest.findings ?? [],
		actions: rest.actions ?? [],
		competitors: rest.competitors ?? [],
		outreach: rest.outreach ?? [],
	};
	await sb("DELETE", `insights?batch_id=eq.${batch_id}&status=eq.${status}`, undefined, "return=minimal");
	await sb("POST", "insights", {
		client_id: client.id,
		batch_id,
		previous_batch_id: previous_batch_id ?? null,
		status,
		headline,
		summary: summary ?? null,
		content,
		report_file: report_file ?? null,
	}, "return=minimal");
	console.log(`Saved ${status} insights for ${values.client}, batch ${batch_id}: "${headline}"`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
