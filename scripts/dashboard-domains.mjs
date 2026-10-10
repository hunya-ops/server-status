// Wrangler reapplies workers_dev on every deploy. Read the dashboard choice
// before deploying, and leave custom domains/routes under dashboard control.
export async function preserveDashboardDomains(
  config,
  environment = process.env,
  request = fetch,
) {
  const accountId = config.account_id || environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token)
    throw new Error(
      "Cloudflare build credentials are missing. Run deployment through Workers Builds.",
    );
  if (
    environment.CLOUDFLARE_ACCOUNT_ID &&
    environment.CLOUDFLARE_ACCOUNT_ID !== accountId
  )
    throw new Error(
      "The deployment account must match the Workers Builds account.",
    );

  const workerName = environment.WRANGLER_CI_OVERRIDE_NAME || config.name;
  const path = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  const missing = Symbol("missing Worker");
  async function read(resource, allowMissing = false) {
    let response;
    let body;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4${path}/${resource}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      body = await response.json();
    } catch {
      throw new Error(
        "Cannot read Cloudflare domain settings. Retry the build.",
      );
    }
    // Only the specific missing-Worker response means this is a first deploy.
    // Authentication failures and other errors must never re-enable a domain.
    const missingWorker =
      response.status === 404 &&
      body?.success === false &&
      Array.isArray(body.errors) &&
      body.errors.length > 0 &&
      body.errors.every((error) => error.code === 10007);
    if (allowMissing && missingWorker) return missing;
    if (!response.ok || body?.success !== true)
      throw new Error(
        `Cannot read Cloudflare domain settings (HTTP ${response.status}). Check the build token's Workers Scripts permission and retry.`,
      );
    return body.result;
  }

  const history = await read("deployments", true);
  config.name = workerName;
  config.account_id = accountId;
  if (history === missing) return config;
  if (!Array.isArray(history?.deployments))
    throw new Error(
      "Cloudflare returned invalid deployment history. Retry the build.",
    );
  // The deployment wizard can create a Worker before its first deployment.
  if (history.deployments.length === 0) return config;

  const subdomain = await read("subdomain");
  if (typeof subdomain?.enabled !== "boolean")
    throw new Error(
      "Cloudflare returned invalid domain settings. Retry the build.",
    );
  config.workers_dev = subdomain.enabled;
  delete config.route;
  delete config.routes;
  return config;
}
