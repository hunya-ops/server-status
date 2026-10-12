import { equal, sameOrigin, clearCookie, sha256, type AuthEnv } from "./auth";
import {
  administrator,
  authorized,
  login,
  setup,
  changePassword,
} from "./administrator";
import { legacyConfigured } from "./auth";
import { HttpError, json, readBody } from "./http";
import {
  settings,
  updateSettings,
  createServer,
  installCommand,
  updateServer,
  revokeServer,
  deleteServer,
  enroll,
} from "./management";
import { validateReport } from "./validation";
import { requestNetwork } from "./network";
import { publicOverview } from "./public";
import { DAY_SECONDS, UPTIME_DAYS } from "../shared/uptime";
import { maxDiskUsage, type ServerSnapshot } from "../shared/types";

interface Env extends AuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}
async function ingest(request: Request, env: Env, now: number) {
  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization))
    return json({ error: "Unauthorized" }, 401);
  const raw = await readBody(request, 32768);
  if (raw === null) return json({ error: "Payload too large" }, 413);
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!validateReport(report, now))
    return json({ error: "Invalid metrics or timestamp" }, 400);
  const server = await env.DB.prepare(
    "SELECT token_hash, interval_seconds FROM servers WHERE id = ? AND enabled = 1",
  )
    .bind(report.serverId)
    .first<{ token_hash: string | null; interval_seconds: number }>();
  if (
    !server?.token_hash ||
    !equal(await sha256(authorization.slice(7)), server.token_hash)
  )
    return json({ error: "Unauthorized" }, 401);
  const minute = Math.floor(report.collectedAt / 60) * 60;
  const network = requestNetwork(request);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO snapshots (server_id, collected_at, received_at, payload, ip_address, country, city) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET collected_at = excluded.collected_at, received_at = excluded.received_at, payload = excluded.payload,
      ip_address = excluded.ip_address, country = excluded.country, city = excluded.city
      WHERE excluded.collected_at > snapshots.collected_at`,
    ).bind(
      report.serverId,
      report.collectedAt,
      now,
      JSON.stringify(report),
      network?.ip ?? null,
      network?.country ?? null,
      network?.city ?? null,
    ),
    env.DB.prepare(
      `INSERT INTO metrics (server_id, minute, cpu, memory, disk)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM snapshots WHERE server_id = ? AND collected_at = ?)
      ON CONFLICT(server_id, minute) DO UPDATE SET cpu = excluded.cpu, memory = excluded.memory, disk = excluded.disk`,
    ).bind(
      report.serverId,
      minute,
      report.cpu.usagePercent,
      report.memory.usagePercent,
      maxDiskUsage(report),
      report.serverId,
      report.collectedAt,
    ),
  ]);
  return json({
    ok: true,
    accepted: results[0].meta.changes > 0,
    serverTime: now,
    interval: server.interval_seconds,
  });
}

async function overview(env: Env, now: number) {
  const result = await env.DB.prepare(
    `SELECT s.id, s.name, s.enabled, s.interval_seconds, s.sort_order, p.received_at, p.payload, p.ip_address, p.country, p.city FROM servers s
    LEFT JOIN snapshots p ON p.server_id = s.id ORDER BY s.sort_order`,
  ).all<{
    id: string;
    name: string;
    enabled: number;
    interval_seconds: number;
    sort_order: number;
    received_at: number | null;
    payload: string | null;
    ip_address: string | null;
    country: string | null;
    city: string | null;
  }>();
  const preferences = await settings(env);
  const servers: ServerSnapshot[] = result.results.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    intervalSeconds: row.interval_seconds,
    sortOrder: row.sort_order,
    warningPercent: preferences.warningPercent,
    lastSeen: row.received_at,
    report: row.payload ? JSON.parse(row.payload) : null,
    network: row.ip_address
      ? { ip: row.ip_address, country: row.country, city: row.city }
      : null,
  }));
  return json({ servers, settings: preferences, generatedAt: now });
}

async function history(url: URL, serverId: string, env: Env, now: number) {
  const range = url.searchParams.get("range") || "24h";
  const hours = ({ "1h": 1, "24h": 24, "7d": 168 } as Record<string, number>)[
    range
  ];
  if (!hours) return json({ error: "时间范围无效" }, 400);
  if (
    !(await env.DB.prepare("SELECT id FROM servers WHERE id = ?")
      .bind(serverId)
      .first())
  )
    return json({ error: "服务器不存在" }, 404);
  const step = range === "7d" ? 900 : range === "24h" ? 300 : 60;
  const preferences = await settings(env);
  const rows = await env.DB.prepare(
    `SELECT CAST(minute / ? AS INTEGER) * ? AS time,
    AVG(cpu) AS cpu, AVG(memory) AS memory, MAX(disk) AS disk
    FROM metrics WHERE server_id = ? AND minute >= ? AND minute <= ? GROUP BY time ORDER BY time LIMIT 700`,
  )
    .bind(
      step,
      step,
      serverId,
      Math.max(now - hours * 3600, now - preferences.retentionDays * 86400),
      now,
    )
    .all();
  return json({ points: rows.results, step, generatedAt: now });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (request.method === "GET" && url.pathname === "/api/public/uptime")
        return await publicOverview(env, now);
      if (request.method === "POST" && url.pathname === "/api/enroll")
        return await enroll(request, env, now);
      if (request.method === "POST" && url.pathname === "/api/setup")
        return await setup(request, env, now);
      if (request.method === "POST" && url.pathname === "/api/ingest")
        return await ingest(request, env, now);
      if (request.method === "POST" && url.pathname === "/api/login") {
        if (Number(request.headers.get("Content-Length") || 0) > 2048)
          return json({ error: "请求过大" }, 413);
        return await login(request, env, now);
      }
      if (request.method === "GET" && url.pathname === "/api/session")
        return json({
          authenticated: await authorized(request, env, now),
          setupRequired: !(await administrator(env)) && !legacyConfigured(env),
          siteName: (await settings(env)).siteName,
        });
      if (!(await authorized(request, env, now)))
        return json({ error: "请先登录" }, 401);
      if (
        ["POST", "PATCH", "DELETE"].includes(request.method) &&
        !sameOrigin(request)
      )
        return json({ error: "请求来源无效" }, 403);
      if (request.method === "POST" && url.pathname === "/api/password")
        return await changePassword(request, env, now);
      if (request.method === "GET" && url.pathname === "/api/settings")
        return json(await settings(env));
      if (request.method === "PATCH" && url.pathname === "/api/settings")
        return await updateSettings(request, env);
      if (request.method === "POST" && url.pathname === "/api/servers")
        return await createServer(request, env, now);
      const managed = url.pathname.match(
        /^\/api\/servers\/([a-z0-9-]{1,64})(?:\/(install|revoke))?$/,
      );
      if (managed) {
        if (request.method === "POST" && managed[2] === "install")
          return await installCommand(request, env, managed[1], now);
        if (request.method === "POST" && managed[2] === "revoke")
          return await revokeServer(env, managed[1]);
        if (request.method === "PATCH" && !managed[2])
          return await updateServer(request, env, managed[1]);
        if (request.method === "DELETE" && !managed[2])
          return await deleteServer(env, managed[1]);
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        if (!sameOrigin(request)) return json({ error: "请求来源无效" }, 403);
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie(request) });
      }
      if (request.method === "GET" && url.pathname === "/api/overview")
        return await overview(env, now);
      const match = url.pathname.match(
        /^\/api\/servers\/([a-z0-9-]+)\/history$/,
      );
      if (request.method === "GET" && match)
        return await history(url, match[1], env, now);
      return json({ error: "接口不存在" }, 404);
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status);
      console.error(
        "Request failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      return json({ error: "暂时无法读取数据，请重试" }, 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const preferences = await settings(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM enrollment_codes WHERE expires_at <= ?").bind(
        now,
      ),
      env.DB.prepare("DELETE FROM metrics WHERE minute < ?").bind(
        now - preferences.retentionDays * 86400,
      ),
      env.DB.prepare("DELETE FROM uptime_intervals WHERE ended_at < ?").bind(
        Math.floor(now / DAY_SECONDS) * DAY_SECONDS -
          (UPTIME_DAYS - 1) * DAY_SECONDS,
      ),
      env.DB.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(
        now - 86400,
      ),
    ]);
  },
} satisfies ExportedHandler<Env>;
