import { describe, expect, it } from "vitest";
// @ts-expect-error Build scripts intentionally use plain ESM outside the TS app.
import { deploymentConfig } from "../scripts/deployment-config.mjs";
// @ts-expect-error Build scripts intentionally use plain ESM outside the TS app.
import { preserveDashboardDomains } from "../scripts/dashboard-domains.mjs";

describe("independent deployment configuration", () => {
  const noLocalFile = "/tmp/status-test-no-instance-config.json";
  it("starts with the default domain enabled and preview URLs disabled", async () => {
    const config = await deploymentConfig({}, noLocalFile);
    expect(config.account_id).toBeUndefined();
    expect(config.routes).toBeUndefined();
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.d1_databases[0].binding).toBe("DB");
  });
  it("uses build variables for an existing instance and rejects provider domains", async () => {
    const config = await deploymentConfig(
      {
        STATUS_WORKER_NAME: "example-worker",
        STATUS_DOMAIN: "status.example.com",
        STATUS_ACCOUNT_ID: "example-account",
        STATUS_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
        STATUS_DATABASE_NAME: "custom-database",
      },
      noLocalFile,
    );
    expect(config.name).toBe("example-worker");
    expect(config.routes).toEqual([
      { pattern: "status.example.com", custom_domain: true },
    ]);
    expect(config.d1_databases[0].database_name).toBe("custom-database");
    expect(config.workers_dev).toBe(true);
    await expect(
      deploymentConfig({ STATUS_DOMAIN: "example.workers.dev" }, noLocalFile),
    ).rejects.toThrow("custom domain");
  });
  it("supports legacy initial defaults and uses the Worker name supplied by Builds", async () => {
    const disabled = await deploymentConfig(
      { STATUS_WORKERS_DEV: "false" },
      noLocalFile,
    );
    expect(disabled.workers_dev).toBe(false);
    const enabled = await deploymentConfig(
      { STATUS_WORKERS_DEV: "true" },
      noLocalFile,
    );
    expect(enabled.workers_dev).toBe(true);
    await expect(
      deploymentConfig({ STATUS_WORKERS_DEV: "invalid" }, noLocalFile),
    ).rejects.toThrow("STATUS_WORKERS_DEV");
    const renamed = await deploymentConfig(
      {
        WRANGLER_CI_OVERRIDE_NAME: "users-panel",
        STATUS_WORKER_NAME: "legacy-name",
      },
      noLocalFile,
    );
    expect(renamed.name).toBe("users-panel");
  });
});

describe("dashboard domain settings across deployments", () => {
  const environment = {
    CLOUDFLARE_ACCOUNT_ID: "example-account",
    CLOUDFLARE_API_TOKEN: "test-only-build-token",
    WRANGLER_CI_OVERRIDE_NAME: "users-panel",
  };
  const initialConfig = () => ({
    name: "template-name",
    workers_dev: true,
    preview_urls: false,
    routes: [{ pattern: "old.example.com", custom_domain: true }],
  });
  const deployed = {
    success: true,
    result: { deployments: [{ id: "existing" }] },
  };
  const api =
    (body: unknown, status = 200) =>
    async (url: string) =>
      Response.json(url.endsWith("/deployments") ? deployed : body, { status });

  it.each([true, false])(
    "preserves the dashboard switch (%s) and leaves dashboard domains/routes alone",
    async (enabled) => {
      const config = await preserveDashboardDomains(
        { ...initialConfig(), workers_dev: !enabled },
        environment,
        async (url: string, options: RequestInit) => {
          expect(url).toMatch(
            /^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/example-account\/workers\/scripts\/users-panel\/(deployments|subdomain)$/,
          );
          expect(options.redirect).toBe("error");
          if (url.endsWith("/deployments")) return Response.json(deployed);
          return Response.json({
            success: true,
            result: { enabled, previews_enabled: false },
          });
        },
      );
      expect(config.name).toBe("users-panel");
      expect(config.account_id).toBe("example-account");
      expect(config.workers_dev).toBe(enabled);
      expect(config.preview_urls).toBe(false);
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("route");
    },
  );

  it("keeps initial defaults only when Cloudflare confirms the Worker does not exist", async () => {
    const config = initialConfig();
    await preserveDashboardDomains(config, environment, async () =>
      Response.json(
        { success: false, errors: [{ code: 10007 }] },
        { status: 404 },
      ),
    );
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toEqual([
      { pattern: "old.example.com", custom_domain: true },
    ]);
  });

  it("enables the initial URL for a Worker created by the wizard with no deployments yet", async () => {
    const config = initialConfig();
    let reads = 0;
    await preserveDashboardDomains(config, environment, async () => {
      reads++;
      return Response.json({ success: true, result: { deployments: [] } });
    });
    expect(config.workers_dev).toBe(true);
    expect(reads).toBe(1);
  });

  it.each([
    [403, { success: false, errors: [{ code: 10000 }] }],
    [404, { success: false, errors: [{ code: 10000 }] }],
    [500, { success: false, errors: [] }],
    [200, { success: true, result: {} }],
  ])(
    "stops deployment on unreadable settings (HTTP %s)",
    async (status, body) => {
      await expect(
        preserveDashboardDomains(
          initialConfig(),
          environment,
          api(body, status),
        ),
      ).rejects.toThrow(/Cloudflare.*domain settings/);
    },
  );

  it.each([{}, null, { deployments: null }])(
    "does not treat malformed deployment history as a first deploy (%j)",
    async (result) => {
      await expect(
        preserveDashboardDomains(initialConfig(), environment, async () =>
          Response.json({ success: true, result }),
        ),
      ).rejects.toThrow("invalid deployment history");
    },
  );

  it("stops on network errors or missing/mismatched build credentials", async () => {
    await expect(
      preserveDashboardDomains(initialConfig(), environment, async () => {
        throw new Error("network unavailable");
      }),
    ).rejects.toThrow("Cannot read Cloudflare domain settings");
    await expect(
      preserveDashboardDomains(initialConfig(), {}, api({})),
    ).rejects.toThrow("build credentials are missing");
    await expect(
      preserveDashboardDomains(
        { ...initialConfig(), account_id: "different-account" },
        environment,
        api({}),
      ),
    ).rejects.toThrow("account must match");
  });
});
