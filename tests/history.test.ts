import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HistoryStore,
  historyPeriod,
  historyCacheSeconds,
} from "../worker/history";
import worker from "../worker/index";

const databases: DatabaseSync[] = [];
async function fixture(
  data: unknown[] = [{ time: 900, cpu: 70, memory: 50, disk: 60 }],
) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const file of readdirSync("migrations").sort())
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  db.exec(
    "INSERT INTO servers (id,name,sort_order) VALUES ('alpha','Private alpha',1),('beta','Private beta',2)",
  );
  const writes: string[] = [];
  const DB = {
    prepare(query: string) {
      let values: any[] = [];
      const statement = {
        bind(...args: any[]) {
          values = args;
          return statement;
        },
        async first() {
          return db.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: db.prepare(query).all(...values) };
        },
        async run() {
          writes.push(query);
          return {
            meta: { changes: Number(db.prepare(query).run(...values).changes) },
          };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const request = vi.fn(async () => Response.json({ data }));
  const store = new HistoryStore(
    {
      DB,
      AE_ACCOUNT_ID: "0".repeat(32),
      AE_DATASET: "test_history",
      AE_QUERY_TOKEN: "private-query-token",
    },
    request,
  );
  await store.initialize();
  return { db, DB, writes, request, store };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000_000);
});
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});
it("merges old history with AE data once at a shared chart bucket and keeps D1 untouched", async () => {
  const f = await fixture();
  f.db.exec(
    "INSERT INTO metrics VALUES ('alpha',600,10,20,30),('alpha',960,11,21,31),('alpha',1020,99,99,99)",
  );
  const result = await f.store.read("alpha", "1h", 7, 4, 1100);
  expect(result.points).toEqual([
    { time: 600, cpu: 10, memory: 20, disk: 30 },
    { time: 900, cpu: 70, memory: 50, disk: 60 },
  ]);
  const [url, options] = f.request.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${"0".repeat(32)}/analytics_engine/sql`,
  );
  expect(options.headers).toMatchObject({
    Authorization: "Bearer private-query-token",
  });
  expect(options.body).toContain("index1 = 'alpha'");
  expect(options.body).toContain("double5 >= 1000");
  expect(options.body).toContain(
    "SUM(double1 * double4 * _sample_interval) / SUM(double4 * _sample_interval)",
  );
  expect(options.redirect).toBe("manual");
  expect(JSON.stringify(result)).not.toMatch(/token|dataset|index1/);
  expect(f.writes.every((q) => !q.includes("metrics"))).toBe(true);
});
it("shares cached SQL results between readers and re-queries after cache expiry", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([
    f.store.read("alpha", "1h", 7, 4, 1100),
    f.store.read("alpha", "1h", 7, 4, 1100),
  ]);
  expect(first).toBe(second);
  expect(f.request).toHaveBeenCalledTimes(1);
  await f.store.read("alpha", "1h", 7, 4, 1200);
  expect(f.request).toHaveBeenCalledTimes(1);
  await f.store.read("alpha", "1h", 7, 4, 1251);
  expect(f.request).toHaveBeenCalledTimes(2);
  await f.store.read("beta", "1h", 7, 4, 1251);
  expect(f.request).toHaveBeenCalledTimes(3);
});
it("rejects invalid ranges and IDs before touching the SQL API", async () => {
  const f = await fixture();
  for (const range of ["bad", "__proto__", "constructor"])
    await expect(
      f.store.read("alpha", range, 7, 4, 1100),
    ).rejects.toMatchObject({ status: 400 });
  await expect(
    f.store.read("alpha' OR 1=1", "1h", 7, 4, 1100),
  ).rejects.toMatchObject({ status: 404 });
  expect(f.request).not.toHaveBeenCalled();
});
it("reports query failures without leaking a token or presenting empty history as success", async () => {
  const f = await fixture();
  f.request.mockResolvedValueOnce(
    new Response("private-query-token upstream secret", { status: 403 }),
  );
  await expect(f.store.read("alpha", "1h", 7, 4, 1100)).rejects.toMatchObject({
    status: 503,
    message: "历史数据暂时无法读取",
  });
  await expect(f.store.read("alpha", "1h", 7, 4, 1101)).rejects.toMatchObject({
    status: 503,
  });
  expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { Location: "https://untrusted.example/" },
    }),
  );
  await expect(f.store.read("alpha", "1h", 7, 4, 1116)).rejects.toMatchObject({
    status: 503,
  });
  expect(f.request).toHaveBeenCalledTimes(2);
  await f.store.read("alpha", "1h", 7, 4, 1132);
  expect(f.request).toHaveBeenCalledTimes(3);
});
it("bounds the query window by retention and rejects malformed numeric results", async () => {
  const f = await fixture([{ time: 900, cpu: "NaN", memory: 50, disk: 60 }]);
  await expect(f.store.read("alpha", "7d", 1, 4, 100000)).rejects.toMatchObject(
    { status: 503 },
  );
  expect(
    (f.request.mock.calls[0] as unknown as [string, RequestInit])[1].body,
  ).toContain("double5 >= 13600");
});
it("records a successful real query once and preserves the cutover across restarts", async () => {
  const f = await fixture();
  await f.store.verify("alpha", 1100);
  await f.store.verify("alpha", 1200);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(
    f.db
      .prepare(
        "SELECT cutover_at,verified_at,verified_points FROM history_migration",
      )
      .get(),
  ).toMatchObject({ cutover_at: 1000, verified_at: 1100, verified_points: 1 });
  vi.setSystemTime(2000_000);
  await f.store.initialize();
  expect(f.store.migration.cutover_at).toBe(1000);
});
it("keeps point and query budgets bounded as the fleet grows", () => {
  for (const servers of [1, 4, 40, 100, 300, 1000]) {
    expect((servers * 86400) / historyPeriod(servers)).toBeLessThanOrEqual(
      80000,
    );
    expect(
      (servers * 3 * 86400) / historyCacheSeconds(servers),
    ).toBeLessThanOrEqual(8000);
  }
  expect(historyPeriod(4)).toBe(30);
  expect(historyCacheSeconds(4)).toBe(150);
});
it("the scheduled handler never deletes historical metric rows", async () => {
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(query: string) {
        queries.push(query);
        return {
          bind() {
            return this;
          },
        };
      },
      batch: vi.fn(async () => []),
    },
  };
  await worker.scheduled({} as ScheduledController, env as any);
  expect(queries.join(" ")).not.toContain("metrics");
});
