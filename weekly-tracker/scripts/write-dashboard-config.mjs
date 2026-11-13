// Writes dashboard/config.js from env so no keys live in the (public) repo.
// Runs as the Netlify build command; locally it reads weekly-tracker/.env.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
	process.loadEnvFile(path.join(root, ".env"));
} catch {}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
	console.error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
	process.exit(1);
}
writeFileSync(
	path.join(root, "dashboard", "config.js"),
	`window.TRACKER_CONFIG = ${JSON.stringify({ url: url.replace(/\/$/, ""), key })};\n`,
);
console.log("Wrote dashboard/config.js");
