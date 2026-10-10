import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";

export async function deploymentConfig(
  environment = process.env,
  localFile = ".local/deployment.json",
) {
  const errors = [];
  const config = parse(await readFile("wrangler.jsonc", "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !config || typeof config !== "object")
    throw new Error("Invalid wrangler.jsonc");
  let instance = {};
  try {
    instance = JSON.parse(await readFile(localFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = {
    name: environment.STATUS_WORKER_NAME || instance.name,
    domain: environment.STATUS_DOMAIN || instance.domain,
    accountId: environment.STATUS_ACCOUNT_ID || instance.accountId,
    databaseId: environment.STATUS_DATABASE_ID || instance.databaseId,
    databaseName: environment.STATUS_DATABASE_NAME || instance.databaseName,
  };
  if (values.name) config.name = values.name;
  if (values.accountId) config.account_id = values.accountId;
  if (values.databaseId) config.d1_databases[0].database_id = values.databaseId;
  if (values.databaseName)
    config.d1_databases[0].database_name = values.databaseName;
  const domain = values.domain || config.vars?.SITE_DOMAIN;
  if (domain) {
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        domain,
      ) ||
      domain.toLowerCase().endsWith(".workers.dev")
    )
      throw new Error("Set a valid custom domain");
    config.routes = [{ pattern: domain.toLowerCase(), custom_domain: true }];
  }
  const workersDev = environment.STATUS_WORKERS_DEV ?? instance.workersDev;
  if (workersDev !== undefined) {
    if (![true, false, "true", "false"].includes(workersDev))
      throw new Error("STATUS_WORKERS_DEV must be true or false");
    config.workers_dev = workersDev === true || workersDev === "true";
  }
  config.preview_urls = false;
  // Generated configs live outside the root; resolve these paths explicitly.
  config.main = resolve(config.main);
  config.assets.directory = resolve(config.assets.directory);
  for (const database of config.d1_databases)
    database.migrations_dir = resolve(database.migrations_dir || "migrations");
  return config;
}

export async function writeDeploymentConfig() {
  const config = await deploymentConfig();
  await mkdir(".wrangler", { recursive: true });
  const path = resolve(".wrangler/deployment.json");
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}
