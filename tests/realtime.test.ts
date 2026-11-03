import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "../worker/realtime";
import { sha256 } from "../worker/auth";
import { report } from "./report";

function socket(attachment: object) {
  return {
    deserializeAttachment: () => attachment,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}
async function fixture() {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort())
    sql.exec(readFileSync(`migrations/${file}`, "utf8"));
  const token = "a".repeat(64),
    hash = await sha256(token);
  for (const id of ["alpha", "beta"])
    sql
      .prepare(
        "INSERT INTO servers (id,name,sort_order,token_hash,interval_seconds) VALUES (?,?,1,?,5)",
      )
      .run(id, `private-${id}`, hash);
  const writes: string[] = [];
  function prepare(query: string) {
    let values: any[] = [];
    const statement = {
      bind(...args: any[]) {
        values = args;
        return statement;
      },
      async all() {
        return { results: sql.prepare(query).all(...values) };
      },
      async first() {
        return sql.prepare(query).get(...values) ?? null;
      },
      async run() {
        writes.push(query);
        return {
          meta: { changes: Number(sql.prepare(query).run(...values).changes) },
        };
      },
    };
    return statement;
  }
  const DB = {
    prepare,
    batch: async (statements: any[]) => {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
  const sockets: WebSocket[] = [];
  const storage = {
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => {}),
  };
  const ctx = {
    blockConcurrencyWhile: (cb: any) => cb(),
    storage,
    getWebSockets: (tag?: string) =>
      sockets.filter((ws) => !tag || ws.deserializeAttachment().role === tag),
    setWebSocketAutoResponse: vi.fn(),
  } as unknown as DurableObjectState;
  const make = () =>
    new RealtimeHub(ctx, { DB, REALTIME: {} as DurableObjectNamespace });
  const hub = make();
  await hub.ready;
  return { sql, DB, writes, hub, sockets, token, hash, make, storage };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000_000);
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("volatile realtime hub", () => {
  it("authenticates legacy and WebSocket connections, bounds messages and isolates server IDs", async () => {
    const f = await fixture();
    for (const auth of ["", `Bearer ${"b".repeat(64)}`]) {
      const res = await f.hub.fetch(
        new Request("https://hub/ingest", {
          method: "POST",
          headers: { Authorization: auth },
          body: JSON.stringify(report("alpha", 1000)),
        }),
      );
      expect(res.status).toBe(401);
      const ws = await f.hub.fetch(
        new Request("https://hub/connect", {
          headers: {
            Upgrade: "websocket",
            "X-Role": "agent",
            "X-Server-Id": "alpha",
            Authorization: auth,
          },
        }),
      );
      expect(ws.status).toBe(401);
    }
    const valid = socket({ role: "agent", id: "alpha", hash: f.hash });
    await f.hub.webSocketMessage(valid, JSON.stringify(report("beta", 1000)));
    expect(valid.close).toHaveBeenCalledWith(1008, "Invalid report");
    await f.hub.webSocketMessage(valid, "x".repeat(32769));
    expect(valid.close).toHaveBeenCalledWith(1009, "Payload too large");
    await f.hub.webSocketMessage(valid, "{");
    expect(valid.close).toHaveBeenCalledWith(1008, "Invalid JSON");
    await f.hub.webSocketMessage(valid, JSON.stringify(report("alpha", 1)));
    expect(f.hub.latest.size).toBe(0);
  });
  it("broadcasts immediately, sends a full snapshot and writes nothing for subsequent samples", async () => {
    const f = await fixture(),
      admin = socket({ role: "admin", expires: 9000 }),
      pub = socket({ role: "public" });
    f.sockets.push(admin, pub);
    await f.hub.accept(
      "alpha",
      report("alpha", 1000),
      { ip: "192.0.2.10", country: "JP", city: "Tokyo" },
      1000,
    );
    const writes = f.writes.length;
    for (let t = 1005; t < 1060; t += 5) {
      vi.setSystemTime(t * 1000);
      await f.hub.accept("alpha", report("alpha", t), null, t);
    }
    expect(f.writes).toHaveLength(writes);
    expect(f.writes.join(" ")).not.toMatch(/snapshots|metrics/);
    expect(f.hub.overview(1060).servers).toHaveLength(2);
    expect(f.hub.latest.get("beta")).toBeUndefined();
    const raw = JSON.stringify(vi.mocked(pub.send).mock.calls);
    for (const privateValue of [
      "192.0.2.10",
      "private-alpha",
      "serverId",
      "hostname",
      "mount",
      f.token,
      "token_hash",
    ])
      expect(raw).not.toContain(privateValue);
    expect(
      vi
        .mocked(admin.send)
        .mock.calls.some(
          ([m]) => JSON.parse(m as string).server?.id === "alpha",
        ),
    ).toBe(true);
    await f.hub.accept("beta", report("beta", 1055), null, 1055);
    expect(f.hub.latest.get("alpha")!.report.serverId).toBe("alpha");
    expect(f.hub.latest.get("beta")!.report.serverId).toBe("beta");
  });
  it("rejects replay without refreshing last_seen and deduplicates short reconnects", async () => {
    const f = await fixture();
    await f.hub.accept("alpha", report("alpha", 1000), null, 1000);
    expect(await f.hub.accept("alpha", report("alpha", 1000), null, 1008)).toBe(
      false,
    );
    expect(f.hub.latest.get("alpha")!.lastSeen).toBe(1000);
    await f.hub.accept("alpha", report("alpha", 1009), null, 1009);
    expect(
      f.sql.prepare("SELECT COUNT(*) AS n FROM monitor_events").get()!.n,
    ).toBe(1);
    vi.setSystemTime(1020_000);
    await f.hub.alarm();
    expect(f.hub.publicOverview(1020).servers[0].state).toBe("stale");
    vi.setSystemTime(1025_000);
    await f.hub.alarm();
    await f.hub.alarm();
    expect(
      f.sql
        .prepare("SELECT online FROM monitor_events ORDER BY occurred_at")
        .all()
        .map((x) => x.online),
    ).toEqual([1, 0]);
    await f.hub.accept("alpha", report("alpha", 1026), null, 1026);
    expect(
      f.sql.prepare("SELECT COUNT(*) AS n FROM monitor_events").get()!.n,
    ).toBe(3);
  });
  it("restarts with empty payload memory and recovers without duplicate events", async () => {
    const f = await fixture();
    await f.hub.accept("alpha", report("alpha", 1000), null, 1000);
    vi.setSystemTime(1005_000);
    const recovered = f.make();
    await recovered.ready;
    expect(recovered.latest.size).toBe(0);
    expect(recovered.overview(1005).servers[0].recovering).toBe(true);
    await recovered.accept("alpha", report("alpha", 1010), null, 1010);
    expect(
      f.sql.prepare("SELECT COUNT(*) AS n FROM monitor_events").get()!.n,
    ).toBe(1);
    vi.setSystemTime(1026_000);
    await recovered.alarm();
    expect(recovered.presence.get("alpha")!.online).toBe(0);
  });
  it("aggregates all metrics into one five-minute row and retries failed flushes", async () => {
    const f = await fixture();
    for (let t = 1000; t < 1200; t += 5) {
      vi.setSystemTime(t * 1000);
      await f.hub.accept("alpha", report("alpha", t), null, t);
    }
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM metrics").get()!.n).toBe(0);
    vi.setSystemTime(1201_000);
    const original = f.DB.prepare.bind(f.DB);
    const prepare = vi.spyOn(f.DB, "prepare").mockImplementation((query) => {
      const statement = original(query);
      if (query.startsWith("INSERT INTO metrics"))
        statement.run = vi
          .fn()
          .mockRejectedValue(new Error("temporary D1 failure"));
      return statement;
    });
    await expect(f.hub.alarm()).rejects.toThrow("temporary D1 failure");
    expect(f.hub.aggregates.size).toBe(1);
    prepare.mockRestore();
    await f.hub.alarm();
    await f.hub.alarm();
    expect(f.sql.prepare("SELECT COUNT(*) AS n FROM metrics").get()!.n).toBe(1);
    expect(
      f.sql.prepare("SELECT cpu,memory,disk FROM metrics").get(),
    ).toMatchObject({ cpu: 23, memory: 25, disk: 30 });
  });
});
