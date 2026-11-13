// Add/update/list tracked clients in Supabase. Client setups live in the DB (not
// git) because the repo is public.
//
//   node weekly-tracker/scripts/client.ts upsert weekly-tracker/clients/acme.json
//   node weekly-tracker/scripts/client.ts list
//   node weekly-tracker/scripts/client.ts weekly acme on|off   # include in the Monday scrape (new clients start off)
//   node weekly-tracker/scripts/client.ts user add acme acme-marketing [password]   # dashboard login for a client
//   node weekly-tracker/scripts/client.ts user reset acme-marketing [password]      # new password, signs them out
//   node weekly-tracker/scripts/client.ts user remove acme-marketing  |  user list [acme]
import { readFileSync } from "node:fs";
import { type Client, env, sb } from "./lib.ts";

const [cmd, arg] = process.argv.slice(2);

const DASHBOARD = process.env.DASHBOARD_URL?.replace(/\/$/, "") || "<DASHBOARD_URL>";

interface DashUser { id: string; username: string; client_id: string; disabled: boolean; locked_until: string | null; last_login_at: string | null }

function randomPassword(): string {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	// Rejection sampling keeps every character equally likely.
	const out: string[] = [];
	while (out.length < 16) {
		for (const b of crypto.getRandomValues(new Uint8Array(32))) {
			if (b < 220 && out.length < 16) out.push(alphabet[b % 55]);
		}
	}
	return out.join("");
}

/** Create or reset a dashboard login; the password is printed once, only its bcrypt hash is stored. */
async function setUser(clientSlug: string, username: string, given?: string) {
	const password = given ?? randomPassword();
	await sb("POST", "rpc/upsert_dashboard_user", { p_client_slug: clientSlug, p_username: username, p_password: password });
	console.log(`Dashboard login for ${clientSlug}:\n  URL:      ${DASHBOARD}\n  Username: ${username.toLowerCase()}\n  Password: ${password}\n(Shown once; only a hash is stored. Any existing sessions for this user were signed out.)`);
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
		updated_at: new Date().toISOString(),
	};
	// Weekly on/off is managed with `client.ts weekly <slug> on|off`; only set it here when the file says so.
	if (typeof cfg.active === "boolean") row.active = cfg.active;
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
	console.log(`Saved ${saved.name} (${saved.slug}): ${saved.prompts.length} prompts, ${saved.competitors.length} competitors, weekly scrape ${saved.active ? "ON" : "off"}`);
	const users = await sb<DashUser[]>("GET", `dashboard_users?select=username&client_id=eq.${saved.id}`);
	if (users.length === 0) await setUser(saved.slug, saved.slug);
	else console.log(`Dashboard logins: ${users.map((u) => u.username).join(", ")} (${DASHBOARD})`);
}

async function list() {
	const clients = await sb<(Client & { dashboard_users: { username: string }[] })[]>("GET", "clients?select=*,dashboard_users(username)&order=name");
	for (const c of clients) {
		const logins = c.dashboard_users.map((u) => u.username).join(",") || "NONE";
		console.log(
			`weekly=${c.active ? "ON " : "off"} ${c.slug.padEnd(28)} ${String(c.prompts.length).padStart(3)} prompts  geo=${c.location_code}  openai=${c.include_openai}  logins=${logins}`,
		);
	}
	console.log(`Dashboard: ${DASHBOARD}`);
	if (clients.length === 0) console.log("No clients yet.");
}

async function setActive(slug: string, active: boolean) {
	const rows = await sb<Client[]>("PATCH", `clients?slug=eq.${encodeURIComponent(slug)}`, { active });
	console.log(rows.length ? `${slug}: weekly scrape ${active ? "ON (included on Mondays)" : "OFF (skipped on Mondays; dashboard still works)"}` : `No client "${slug}"`);
}

async function userCmd([sub, a, b, c]: string[]) {
	if (sub === "add" && a && b) return setUser(a, b, c);
	if (sub === "reset" && a) {
		const [u] = await sb<(DashUser & { clients: { slug: string } })[]>("GET", `dashboard_users?select=*,clients(slug)&username=eq.${encodeURIComponent(a.toLowerCase())}`);
		if (!u) throw new Error(`No user "${a}"`);
		return setUser(u.clients.slug, u.username, b);
	}
	if (sub === "remove" && a) {
		const rows = await sb<DashUser[]>("DELETE", `dashboard_users?username=eq.${encodeURIComponent(a.toLowerCase())}`);
		return console.log(rows.length ? `Removed ${a} (signed out everywhere).` : `No user "${a}"`);
	}
	if (sub === "list") {
		const users = await sb<(DashUser & { clients: { slug: string } })[]>("GET", `dashboard_users?select=*,clients!inner(slug)${a ? `&clients.slug=eq.${encodeURIComponent(a)}` : ""}&order=username`);
		for (const u of users) {
			const locked = u.locked_until && new Date(u.locked_until) > new Date() ? `  LOCKED until ${u.locked_until}` : "";
			console.log(`${u.username.padEnd(28)} client=${u.clients.slug.padEnd(24)} last_login=${u.last_login_at ?? "never"}${u.disabled ? "  DISABLED" : ""}${locked}`);
		}
		return users.length ? undefined : console.log("No users.");
	}
	throw new Error("Usage: user add <client> <username> [pw] | user reset <username> [pw] | user remove <username> | user list [client]");
}

async function main() {
	env("SUPABASE_URL");
	if (cmd === "upsert" && arg) return upsert(arg);
	if (cmd === "list") return list();
	if ((cmd === "pause" || cmd === "resume") && arg) return setActive(arg, cmd === "resume");
	if (cmd === "weekly" && arg && ["on", "off"].includes(process.argv[4] ?? "")) return setActive(arg, process.argv[4] === "on");
	if (cmd === "user") return userCmd(process.argv.slice(3));
	console.error("Usage: client.ts upsert <file.json> | list | weekly <slug> on|off | user add <client> <username> [pw] | user reset <username> [pw] | user remove <username> | user list [client]");
	process.exit(1);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
