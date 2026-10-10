import { spawnSync } from "node:child_process";
import { writeDeploymentConfig } from "./deployment-config.mjs";
const dryRun = process.argv.includes("--dry-run");
if (!dryRun && process.env.CI !== "true" && !process.env.WORKERS_CI) {
  throw new Error(
    "Publish through GitHub and Cloudflare Workers Builds. Use npm run deploy:check for a local dry run.",
  );
}
const config = await writeDeploymentConfig();
const cli = "node_modules/wrangler/bin/wrangler.js";
function command(args) {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--config", config],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
if (dryRun) command(["deploy", "--dry-run", "--outdir", ".wrangler/dry-run"]);
else {
  command(["d1", "migrations", "apply", "DB", "--remote"]);
  command(["deploy"]);
}
