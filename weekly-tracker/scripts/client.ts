// Add/update/list tracked clients in Supabase. Client setups live in the DB (not
// git) because the repo is public.
//
//   node weekly-tracker/scripts/client.ts upsert weekly-tracker/clients/acme.json
//   node weekly-tracker/scripts/client.ts list
//   node weekly-tracker/scripts/client.ts pause acme      |  resume acme
//   node weekly-tracker/scripts/client.ts password acme   # new random dashboard password (printed once)
import { readFileSync } from "node:fs";
import { type Client, env, sb } from "./lib.ts";

const [cmd, arg] = process.argv.slice(2);

function dashboardUrl(token: string): string {
	const base = process.env.DASHBOARD_URL?.replace(/\/$/, "");
	return base ? `${base}/?c=${token}` : `<DASHBOARD_URL>/?c=${token}`;
}

async function upsert(file: string) {
	const cfg = JSON.parse(readFileSync(file, "utf8"));
	for (const k of ["slug", "name", "domain", "prompts"]) {
		if (!cfg[k] || (Array.isArray(cfg[k]) && cfg[k].length === 0)) throw new Error(`${file}: "${k}" is required`);
	}
	const tooLong = (cfg.prompts as string[]).filter((p) => p.length > 500);
	if (tooLong.length) throw new Error(`Prompts over 500 chars: ${tooLong.map((p) => p.slice(0, 40)).join(" | ")}`);

	const row: Record<string, unknown> = {
		slug: cfg.slug,
		name: cfg.name,
		domain: cfg.domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
		aliases: cfg.aliases ?? [],
		competitors: cfg.competitors ?? [],
		prompts: cfg.prompts,
		location_code: cfg.location_code ?? 2840,
		language_code: cfg.language_code ?? "en",
		include_openai: cfg.include_openai ?? true,
		active: cfg.active ?? true,
		updated_at: new Date().toISOString(),
	};
	// Analysis context for aeo-data-analysis; omitted keys keep what's already stored.
	// Merge so scraped branding (written by brand.ts) survives a re-upsert.
	if (cfg.profile) {
		const [current] = await sb<{ profile: Record<string, unknown> }[]>(
			"GET",
			`clients?select=profile&slug=eq.${encodeURIComponent(cfg.slug)}`,
		);
		row.profile = { ...(current?.profile ?? {}), ...cfg.profile };
	}
	if (cfg.prompt_tags) row.prompt_tags = cfg.prompt_tags;
	const [saved] = await sb<Client[]>("POST", "clients?on_conflict=slug", row, "return=representation,resolution=merge-duplicates");
	console.log(`Saved ${saved.name} (${saved.slug}): ${saved.prompts.length} prompts, ${saved.competitors.length} competitors`);
	console.log(`Dashboard: ${dashboardUrl(saved.share_token)}`);
	if (!(saved as Client & { dashboard_password_hash: string | null }).dashboard_password_hash) {
		await setPassword(saved.slug, null);
	}
}

/** Generate (or set) a dashboard password; only its bcrypt hash is stored. */
async function setPassword(slug: string, given: string | null, clear = false) {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(14));
	const password = clear ? null : (given ?? Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""));
	const ok = await sb<boolean>("POST", "rpc/set_client_password", { p_slug: slug, p_password: password });
	if (!ok) throw new Error(`No client "${slug}"`);
	console.log(clear ? `Password removed for ${slug} — dashboard is open to anyone with the link.` : `Dashboard password for ${slug}: ${password}\n(Shown once; only a hash is stored. Share it separately from the link.)`);
}

async function list() {
	const clients = await sb<Client[]>("GET", "clients?select=*&order=name");
	for (const c of clients) {
		console.log(
			`${c.active ? "●" : "○"} ${c.slug.padEnd(28)} ${String(c.prompts.length).padStart(3)} prompts  geo=${c.location_code}  openai=${c.include_openai}  pwd=${(c as Client & { dashboard_password_hash: string | null }).dashboard_password_hash ? "set" : "NONE"}  ${dashboardUrl(c.share_token)}`,
		);
	}
	if (clients.length === 0) console.log("No clients yet.");
}

async function setActive(slug: string, active: boolean) {
	const rows = await sb<Client[]>("PATCH", `clients?slug=eq.${encodeURIComponent(slug)}`, { active });
	console.log(rows.length ? `${slug} ${active ? "resumed" : "paused"}` : `No client "${slug}"`);
}

async function main() {
	env("SUPABASE_URL");
	if (cmd === "upsert" && arg) return upsert(arg);
	if (cmd === "list") return list();
	if ((cmd === "pause" || cmd === "resume") && arg) return setActive(arg, cmd === "resume");
	if (cmd === "password" && arg) {
		const extra = process.argv[4];
		return setPassword(arg, extra && extra !== "--clear" ? extra : null, extra === "--clear");
	}
	console.error("Usage: client.ts upsert <file.json> | list | pause <slug> | resume <slug> | password <slug> [new-password|--clear]");
	process.exit(1);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
