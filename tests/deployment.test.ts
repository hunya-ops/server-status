import { describe, expect, it } from "vitest";
// @ts-expect-error Build scripts intentionally use plain ESM outside the TS app.
import { deploymentConfig } from "../scripts/deployment-config.mjs";

describe("independent deployment configuration", () => {
  const noLocalFile = "/tmp/status-test-no-instance-config.json";
  it("starts without an account or domain and keeps provider URLs disabled", async () => {
    const config = await deploymentConfig({}, noLocalFile);
    expect(config.account_id).toBeUndefined();
    expect(config.routes).toEqual([]);
    expect(config.workers_dev).toBe(false);
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
    await expect(
      deploymentConfig({ STATUS_DOMAIN: "example.workers.dev" }, noLocalFile),
    ).rejects.toThrow("custom domain");
  });
});
