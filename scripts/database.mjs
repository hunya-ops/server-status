import { spawnSync } from "node:child_process";
import { writeDeploymentConfig } from "./deployment-config.mjs";
const mode = process.argv[2];
if (!["--local", "--remote"].includes(mode))
  throw new Error("Specify --local or --remote");
const config = await writeDeploymentConfig();
const result = spawnSync(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    mode,
    "--config",
    config,
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status || 0;
