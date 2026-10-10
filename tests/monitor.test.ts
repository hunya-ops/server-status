import { describe, expect, it } from "vitest";
import {
  authenticated,
  configured,
  sessionCookie,
  sha256,
  sameOrigin,
  passwordHash,
  verifyPassword,
} from "../worker/auth";
import { validateReport } from "../worker/validation";
import { serverState } from "../shared/types";
import { report } from "./report";

describe("private dashboard sessions", () => {
  const env = {
    SESSION_SECRET: "test-secret-with-at-least-32-characters",
    DASHBOARD_PASSWORD_HASH: "a".repeat(64),
  };
  it("rejects missing credentials and forged cookies", async () => {
    expect(configured({})).toBe(false);
    expect(
      await authenticated(
        new Request("https://status.example", {
          headers: { Cookie: "status_session=v1.9999999999.fake" },
        }),
        env,
        1000,
      ),
    ).toBe(false);
  });
  it("accepts a signed cookie, rejects expiry and signature tampering", async () => {
    const cookie = await sessionCookie(
      new Request("https://status.example"),
      env,
      1000,
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const request = new Request("https://status.example", {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(await authenticated(request, env, 1001)).toBe(true);
    expect(await authenticated(request, env, 87400)).toBe(false);
    expect(
      await authenticated(
        new Request("https://status.example", {
          headers: { Cookie: cookie.split(";")[0] + "x" },
        }),
        env,
        1001,
      ),
    ).toBe(false);
    expect(
      await authenticated(
        request,
        {
          ...env,
          SESSION_SECRET: "another-secret-with-at-least-32-characters",
        },
        1001,
      ),
    ).toBe(false);
  });
  it("requires same-origin writes", () => {
    expect(
      sameOrigin(
        new Request("https://status.example/api/login", {
          headers: { Origin: "https://other.example" },
        }),
      ),
    ).toBe(false);
    expect(
      sameOrigin(
        new Request("https://status.example/api/login", {
          headers: { Origin: "https://status.example" },
        }),
      ),
    ).toBe(true);
  });
  it("hashes credentials without storing plaintext", async () => {
    expect(await sha256("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("metrics input", () => {
  it("accepts valid metrics and rejects stale reports, invalid percentages and inconsistent memory", () => {
    const sample = report("example-server", 1000);
    expect(validateReport(sample, 1000)).toBe(true);
    expect(validateReport(sample, 1121)).toBe(false);
    expect(
      validateReport(
        { ...sample, cpu: { ...sample.cpu, usagePercent: NaN } },
        1000,
      ),
    ).toBe(false);
    expect(
      validateReport(
        { ...sample, memory: { ...sample.memory, usagePercent: 99 } },
        1000,
      ),
    ).toBe(false);
    expect(
      validateReport(
        { ...sample, disks: [...sample.disks, ...sample.disks] },
        1000,
      ),
    ).toBe(false);
    expect(
      validateReport(
        { ...sample, cpu: { ...sample.cpu, usagePercent: 101 } },
        1000,
      ),
    ).toBe(false);
  });
});

describe("server freshness", () => {
  it("uses the reporting interval, configured threshold and enabled state", () => {
    const server = {
      id: "example-server",
      name: "Example",
      lastSeen: 1000,
      report: report("example-server", 1000),
      intervalSeconds: 300,
      warningPercent: 20,
    };
    expect(serverState(server, 1899)).toBe("warning");
    expect(serverState(server, 1901)).toBe("offline");
    expect(serverState({ ...server, enabled: false }, 1901)).toBe("disabled");
  });
  it("marks missing and stale data even when the last reported metrics were healthy", () => {
    expect(
      serverState(
        {
          id: "example-server",
          name: "example-server",
          lastSeen: null,
          report: null,
        },
        1000,
      ),
    ).toBe("pending");
    expect(
      serverState(
        {
          id: "example-server",
          name: "example-server",
          lastSeen: 1000,
          report: report("example-server", 1000),
        },
        1180,
      ),
    ).toBe("online");
    expect(
      serverState(
        {
          id: "example-server",
          name: "example-server",
          lastSeen: 1000,
          report: report("example-server", 1000),
        },
        1181,
      ),
    ).toBe("offline");
    const high = report("example-server", 1000);
    high.cpu.usagePercent = 95;
    expect(
      serverState(
        {
          id: "example-server",
          name: "example-server",
          lastSeen: 1000,
          report: high,
        },
        1001,
      ),
    ).toBe("warning");
  });
});

describe("administrator credentials", () => {
  const env = { SETUP_KEY: "test-setup-key-with-at-least-32-characters" };
  it("salts and peppers passwords and rejects an altered runtime secret", async () => {
    const hash = await passwordHash("a-long-testing-password", env);
    expect(hash).not.toBe(await passwordHash("a-long-testing-password", env));
    expect(await verifyPassword("a-long-testing-password", hash, env)).toBe(
      true,
    );
    expect(await verifyPassword("incorrect-password", hash, env)).toBe(false);
    expect(
      await verifyPassword("a-long-testing-password", hash, {
        SETUP_KEY: "different-key-with-at-least-32-characters",
      }),
    ).toBe(false);
  });
  it("binds new sessions to the password version and denies legacy sessions after migration", async () => {
    const request = new Request("https://status.example.com");
    const cookie = await sessionCookie(request, env, 1000, "test-version");
    const signed = new Request(request.url, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    expect(await authenticated(signed, env, 1001, "test-version")).toBe(true);
    expect(await authenticated(signed, env, 1001, "changed-version")).toBe(
      false,
    );
    expect(await authenticated(signed, env, 87400, "test-version")).toBe(false);
  });
});
