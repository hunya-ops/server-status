import type { HistoryPoint } from "../shared/types";
import { HttpError } from "./http";

export interface HistoryEnv {
  DB: D1Database;
  HISTORY?: AnalyticsEngineDataset;
  // Optional service binding used by the local SQL contract fixture.
  AE_SQL?: Fetcher;
  AE_QUERY_TOKEN?: string;
  AE_ACCOUNT_ID?: string;
  AE_DATASET?: string;
}
export interface Aggregate {
  start: number;
  end: number;
  count: number;
  cpu: number;
  memory: number;
  disk: number;
}
interface Migration {
  dataset: string;
  cutover_at: number;
  verified_at: number | null;
}
export interface HistoryResult {
  points: HistoryPoint[];
  step: number;
  generatedAt: number;
}
// Leave room for other account usage. One point contains all three metrics.
export const HISTORY_POINT_BUDGET = 80_000;
export const HISTORY_QUERY_BUDGET = 8_000;
export const historyPeriod = (servers: number) =>
  Math.max(30, Math.ceil((servers * 86400) / HISTORY_POINT_BUDGET / 30) * 30);
export const historyCacheSeconds = (servers: number) =>
  Math.max(
    60,
    Math.ceil((servers * 3 * 86400) / HISTORY_QUERY_BUDGET / 30) * 30,
  );
const unavailable = () => new HttpError(503, "历史数据暂时无法读取");

export class HistoryStore {
  migration!: Migration;
  private cache = new Map<string, { expires: number; value: HistoryResult }>();
  private pending = new Map<string, Promise<HistoryResult>>();
  private failedUntil = new Map<string, number>();
  private generation = 0;
  private probing = false;
  private nextProbeAt = 0;
  private probeFailures = 0;
  constructor(
    private env: HistoryEnv,
    private request: typeof fetch = fetch,
  ) {}

  async initialize() {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(this.env.AE_DATASET ?? ""))
      throw new Error("Invalid Analytics Engine dataset configuration");
    const dataset = this.env.AE_DATASET!;
    const existing = await this.env.DB.prepare(
      "SELECT dataset, cutover_at, verified_at FROM history_migration WHERE dataset = ?",
    )
      .bind(dataset)
      .first<Migration>();
    if (existing) this.migration = existing;
    else {
      const cutover = Math.floor(Date.now() / 1000);
      await this.env.DB.prepare(
        "INSERT OR IGNORE INTO history_migration (dataset, cutover_at) VALUES (?, ?)",
      )
        .bind(dataset, cutover)
        .run();
      this.migration = (await this.env.DB.prepare(
        "SELECT dataset, cutover_at, verified_at FROM history_migration WHERE dataset = ?",
      )
        .bind(dataset)
        .first<Migration>())!;
    }
  }
  invalidate() {
    this.generation++;
    this.cache.clear();
    this.failedUntil.clear();
  }
  write(serverId: string, bucket: Aggregate) {
    if (!this.env.HISTORY) throw new Error("Analytics Engine binding missing");
    this.env.HISTORY.writeDataPoint({
      indexes: [serverId],
      blobs: ["v1"],
      doubles: [
        bucket.cpu / bucket.count,
        bucket.memory / bucket.count,
        bucket.disk,
        bucket.count,
        bucket.start,
        bucket.end,
      ],
    });
  }
  private async query(sql: string): Promise<unknown[]> {
    if (
      !this.env.AE_QUERY_TOKEN ||
      !/^[a-f0-9]{32}$/i.test(this.env.AE_ACCOUNT_ID ?? "")
    )
      throw unavailable();
    try {
      const request = this.env.AE_SQL
        ? this.env.AE_SQL.fetch.bind(this.env.AE_SQL)
        : this.request;
      const response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${this.env.AE_ACCOUNT_ID}/analytics_engine/sql`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.AE_QUERY_TOKEN}`,
            "Content-Type": "text/plain",
          },
          body: sql,
          // workerd supports manual/follow, but not redirect:error. Reject
          // every non-2xx response below so credentials never follow redirects.
          redirect: "manual",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) throw unavailable();
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("data" in body) ||
        !Array.isArray(body.data) ||
        body.data.length > 700
      )
        throw unavailable();
      return body.data;
    } catch {
      throw unavailable();
    }
  }
  private async analytics(
    serverId: string,
    from: number,
    to: number,
    step: number,
  ): Promise<HistoryPoint[]> {
    const rows = await this
      .query(`SELECT intDiv(double5, ${step}) * ${step} AS time,
      SUM(double1 * double4 * _sample_interval) / SUM(double4 * _sample_interval) AS cpu,
      SUM(double2 * double4 * _sample_interval) / SUM(double4 * _sample_interval) AS memory,
      MAX(double3) AS disk FROM ${this.migration.dataset}
      WHERE index1 = '${serverId}' AND blob1 = 'v1'
      AND double5 >= ${Math.max(from, this.migration.cutover_at)} AND double5 <= ${to}
      GROUP BY time ORDER BY time LIMIT 700 FORMAT JSON`);
    return rows.map((row) => {
      if (!row || typeof row !== "object") throw unavailable();
      const source = row as Record<string, unknown>;
      const point = Object.fromEntries(
        ["time", "cpu", "memory", "disk"].map((key) => {
          const value = source[key];
          if (
            (typeof value !== "number" && typeof value !== "string") ||
            value === ""
          )
            throw unavailable();
          return [key, Number(value)];
        }),
      ) as unknown as HistoryPoint;
      if (
        !Number.isInteger(point.time) ||
        point.time < Math.floor(from / step) * step ||
        point.time > to ||
        [point.cpu, point.memory, point.disk].some(
          (value) => !Number.isFinite(value) || value < 0 || value > 100,
        )
      )
        throw unavailable();
      return point;
    });
  }
  // This query runs outside the realtime handler queue. A slow SQL API cannot
  // delay Agent acknowledgements or browser broadcasts.
  async verify(serverId: string, now: number) {
    if (this.migration.verified_at || this.probing || now < this.nextProbeAt)
      return;
    this.probing = true;
    try {
      const points = await this.analytics(
        serverId,
        Math.max(0, Math.floor(now) - 3600),
        Math.floor(now),
        300,
      );
      if (!points.length) {
        this.nextProbeAt = now + 30;
        return;
      }
      await this.env.DB.prepare(
        "UPDATE history_migration SET verified_at = ?, verified_points = ? WHERE dataset = ? AND verified_at IS NULL",
      )
        .bind(Math.floor(now), points.length, this.migration.dataset)
        .run();
      this.migration.verified_at = Math.floor(now);
      console.log("Analytics Engine history query verified");
    } catch {
      this.nextProbeAt =
        now + Math.min(300, 30 * 2 ** Math.min(this.probeFailures++, 4));
      console.error(
        "Analytics Engine history query verification failed; retrying",
      );
    } finally {
      this.probing = false;
    }
  }
  async read(
    serverId: string,
    range: string,
    retentionDays: number,
    servers: number,
    now: number,
  ): Promise<HistoryResult> {
    if (!/^[a-z0-9-]{1,64}$/.test(serverId))
      throw new HttpError(404, "服务器不存在");
    const hours = ({ "1h": 1, "24h": 24, "7d": 168 } as Record<string, number>)[
      range
    ];
    if (!Number.isFinite(hours)) throw new HttpError(400, "时间范围无效");
    const key = `${serverId}:${range}:${retentionDays}:${this.generation}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > now) return cached.value;
    if ((this.failedUntil.get(key) ?? 0) > now) throw unavailable();
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const work = (async () => {
      const step = range === "7d" ? 900 : 300;
      const from = Math.max(
        0,
        Math.floor(now) - Math.min(hours * 3600, retentionDays * 86400),
      );
      const to = Math.floor(now);
      const legacy = await this.env.DB.prepare(
        `SELECT CAST(minute / ? AS INTEGER) * ? AS time,
        AVG(cpu) AS cpu, AVG(memory) AS memory, MAX(disk) AS disk
        FROM metrics WHERE server_id = ? AND minute >= ? AND minute <= ? AND minute < ?
        GROUP BY time ORDER BY time LIMIT 700`,
      )
        .bind(step, step, serverId, from, to, this.migration.cutover_at)
        .all<HistoryPoint>();
      // Successful AE reads are required even when no new points exist yet.
      // Errors must not silently turn into an empty or legacy-only chart.
      const fresh = await this.analytics(serverId, from, to, step);
      const merged = new Map(legacy.results.map((p) => [p.time, p]));
      // At the boundary a coarse chart bucket can contain both sources. Use
      // its AE value once, preserving the old D1 rows for rollback.
      for (const point of fresh) merged.set(point.time, point);
      const value = {
        points: [...merged.values()]
          .sort((a, b) => a.time - b.time)
          .slice(-700),
        step,
        generatedAt: to,
      };
      if (generation === this.generation) {
        // Bound memory even when nodes are deleted or settings change.
        if (this.cache.size >= Math.max(3, servers * 3))
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {
          expires: now + historyCacheSeconds(servers),
          value,
        });
      }
      return value;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } catch (error) {
      this.failedUntil.set(key, now + 15);
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }
}
