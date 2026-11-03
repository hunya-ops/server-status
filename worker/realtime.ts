import { equal, sha256 } from "./auth";
import {
  HistoryStore,
  historyPeriod,
  type HistoryEnv,
  type Aggregate,
} from "./history";
import { HttpError, json, readBody } from "./http";
import { settings } from "./management";
import { validateReport } from "./validation";
import {
  maxDiskUsage,
  offlineSeconds,
  type Overview,
  type Report,
  type ServerNetwork,
  type ServerSnapshot,
  type Settings,
} from "../shared/types";
import {
  uptimeHistory,
  type PublicOverview,
  type UptimeInterval,
} from "../shared/uptime";

export interface RealtimeEnv extends HistoryEnv {
  DB: D1Database;
  REALTIME: DurableObjectNamespace;
}
interface Config {
  id: string;
  name: string;
  enabled: number;
  interval_seconds: number;
  sort_order: number;
  token_hash: string | null;
}
interface Presence {
  server_id: string;
  online: number;
  since: number;
  changed_at: number;
}
interface Live {
  report: Report;
  collectedAt: number;
  receivedAt: number;
  lastSeen: number;
  network: ServerNetwork | null;
}
interface Attachment {
  role: "agent" | "admin" | "public";
  id?: string;
  hash?: string;
  network?: ServerNetwork | null;
  expires?: number;
}
export const hub = (env: RealtimeEnv) =>
  env.REALTIME.get(env.REALTIME.idFromName("status-v1"));

// Only this singleton receives traffic from the Worker. No public route forwards
// arbitrary URLs/headers to it. Payloads and aggregates are deliberately volatile.
export class RealtimeHub implements DurableObject {
  configs = new Map<string, Config>();
  latest = new Map<string, Live>();
  presence = new Map<string, Presence>();
  tracking = new Map<string, number>();
  intervals = new Map<string, UptimeInterval[]>();
  aggregates = new Map<string, Aggregate>();
  completed = new Map<string, Aggregate[]>();
  history: HistoryStore;
  preferences!: Settings;
  recoveredAt = Date.now() / 1000;
  ready: Promise<void>;
  // Serialize all handlers across external I/O, including alarms and refreshes.
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private ctx: DurableObjectState,
    private env: RealtimeEnv,
  ) {
    this.history = new HistoryStore(env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.load();
      await this.history.initialize();
      await this.schedule();
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  async load() {
    const [configs, presence, tracking, intervals, preferences] =
      await Promise.all([
        this.env.DB.prepare(
          "SELECT id, name, enabled, interval_seconds, sort_order, token_hash FROM servers ORDER BY sort_order, id",
        ).all<Config>(),
        this.env.DB.prepare(
          "SELECT server_id, online, since, changed_at FROM monitor_presence",
        ).all<Presence>(),
        this.env.DB.prepare(
          "SELECT server_id, started_at FROM uptime_tracking",
        ).all<{ server_id: string; started_at: number }>(),
        this.env.DB.prepare(
          "SELECT server_id, started_at, ended_at FROM uptime_intervals WHERE ended_at > ?",
        )
          .bind(Math.floor(Date.now() / 1000) - 90 * 86400)
          .all<UptimeInterval & { server_id: string }>(),
        settings(this.env),
      ]);
    this.configs = new Map(configs.results.map((c) => [c.id, c]));
    this.presence = new Map(presence.results.map((p) => [p.server_id, p]));
    this.tracking = new Map(
      tracking.results.map((t) => [t.server_id, t.started_at]),
    );
    this.intervals.clear();
    for (const row of intervals.results)
      this.intervals.set(row.server_id, [
        ...(this.intervals.get(row.server_id) ?? []),
        row,
      ]);
    this.preferences = preferences;
    this.history.invalidate();
  }
  snapshot(c: Config): ServerSnapshot {
    const live = this.latest.get(c.id);
    return {
      id: c.id,
      name: c.name,
      enabled: Boolean(c.enabled),
      intervalSeconds: c.interval_seconds,
      sortOrder: c.sort_order,
      warningPercent: this.preferences.warningPercent,
      lastSeen: live?.lastSeen ?? null,
      report: live?.report ?? null,
      network: live?.network ?? null,
      offline: this.presence.get(c.id)?.online === 0,
      recovering: !live && this.presence.get(c.id)?.online === 1,
    };
  }
  overview(now: number): Overview {
    return {
      servers: [...this.configs.values()].map((c) => this.snapshot(c)),
      settings: this.preferences,
      generatedAt: now,
    };
  }
  publicIds(): string[] {
    return [...this.configs.values()]
      .filter((c) => c.enabled)
      .sort((a, b) => {
        const x = this.latest.get(a.id)?.network,
          y = this.latest.get(b.id)?.network;
        return (
          Number(!x?.country) - Number(!y?.country) ||
          (x?.country ?? "").localeCompare(y?.country ?? "") ||
          Number(!x?.city) - Number(!y?.city) ||
          (x?.city ?? "").localeCompare(y?.city ?? "") ||
          a.sort_order - b.sort_order ||
          a.id.localeCompare(b.id)
        );
      })
      .map((c) => c.id);
  }
  publicServer(id: string, now: number) {
    const c = this.configs.get(id)!,
      live = this.latest.get(id),
      p = this.presence.get(id);
    const history = [...(this.intervals.get(id) ?? [])];
    if (p?.online)
      history.push({
        started_at: p.since,
        ended_at: live
          ? Math.min(now, live.lastSeen + offlineSeconds(c.interval_seconds))
          : Math.min(now, this.recoveredAt),
      });
    const age = live ? now - live.lastSeen : Infinity;
    return {
      country: live?.network?.country ?? null,
      city: live?.network?.city ?? null,
      state: !live
        ? p
          ? p.online
            ? ("stale" as const)
            : ("offline" as const)
          : ("pending" as const)
        : age >= offlineSeconds(c.interval_seconds)
          ? ("offline" as const)
          : age >= c.interval_seconds * 2
            ? ("stale" as const)
            : ("online" as const),
      uptimeSeconds: live?.report.uptimeSeconds ?? null,
      cpuCores: live?.report.cpu.cores ?? null,
      memoryTotalBytes: live?.report.memory.totalBytes ?? null,
      diskTotalBytes: live
        ? live.report.disks.reduce((s, d) => s + d.totalBytes, 0)
        : null,
      ...uptimeHistory(this.tracking.get(id) ?? null, history, now),
    };
  }
  publicOverview(now: number): PublicOverview {
    return {
      generatedAt: now,
      servers: this.publicIds().map((id) => this.publicServer(id, now)),
    };
  }
  send(ws: WebSocket, value: unknown) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      try {
        ws.close(1011, "Reconnect");
      } catch {}
    }
  }
  broadcast(id?: string, resetPublic = false) {
    const now = Date.now() / 1000,
      ids = this.publicIds();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.role === "agent") continue;
      if (a.role === "admin" && (a.expires ?? 0) <= now) {
        ws.close(4401, "Session expired");
        continue;
      }
      if (a.role === "admin")
        this.send(
          ws,
          id && this.configs.has(id)
            ? {
                type: "update",
                server: this.snapshot(this.configs.get(id)!),
                generatedAt: now,
              }
            : { type: "snapshot", data: this.overview(now) },
        );
      else
        this.send(
          ws,
          id && !resetPublic && ids.includes(id)
            ? {
                type: "update",
                index: ids.indexOf(id),
                server: this.publicServer(id, now),
                generatedAt: now,
              }
            : { type: "snapshot", data: this.publicOverview(now) },
        );
    }
  }
  async transition(id: string, online: boolean, at: number) {
    const previous = this.presence.get(id);
    if (previous?.online === Number(online)) return;
    const statements: D1PreparedStatement[] = [];
    if (online) {
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO uptime_tracking (server_id, started_at) VALUES (?, ?) ON CONFLICT(server_id) DO NOTHING",
        ).bind(id, at),
      );
    } else if (previous?.online) {
      statements.push(
        this.env.DB.prepare(
          "INSERT INTO uptime_intervals (server_id, started_at, ended_at) VALUES (?, ?, ?) ON CONFLICT(server_id, started_at) DO UPDATE SET ended_at = MAX(ended_at, excluded.ended_at)",
        ).bind(id, previous.since, Math.max(previous.since, at)),
      );
    }
    const p = {
      server_id: id,
      online: Number(online),
      since: at,
      changed_at: at,
    };
    statements.push(
      this.env.DB.prepare(
        "INSERT INTO monitor_presence (server_id, online, since, changed_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET online=excluded.online, since=excluded.since, changed_at=excluded.changed_at",
      ).bind(id, p.online, at, at),
    );
    statements.push(
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO monitor_events (server_id, online, occurred_at) VALUES (?, ?, ?)",
      ).bind(id, p.online, at),
    );
    await this.env.DB.batch(statements);
    if (!online && previous?.online)
      this.intervals.set(id, [
        ...(this.intervals.get(id) ?? []),
        { started_at: previous.since, ended_at: at },
      ]);
    if (online && !this.tracking.has(id)) this.tracking.set(id, at);
    this.presence.set(id, p);
  }
  async accept(
    id: string,
    report: Report,
    network: ServerNetwork | null,
    now: number,
  ) {
    const c = this.configs.get(id);
    if (!c?.enabled) return false;
    const prev = this.latest.get(id);
    if (prev && report.collectedAt <= prev.collectedAt) return false;
    const oldOrder = this.publicIds().join(",");
    // A delayed alarm must not hide a real outage on the next incoming report.
    if (prev && now - prev.lastSeen >= offlineSeconds(c.interval_seconds))
      await this.transition(
        id,
        false,
        prev.lastSeen + offlineSeconds(c.interval_seconds),
      );
    await this.transition(id, true, now);
    this.latest.set(id, {
      report,
      collectedAt: report.collectedAt,
      receivedAt: now,
      lastSeen: now,
      network,
    });
    const period = historyPeriod(
      [...this.configs.values()].filter((c) => c.enabled).length,
    );
    let bucket = this.aggregates.get(id);
    if (bucket && now >= bucket.end) {
      this.finish(id, bucket);
      bucket = undefined;
    }
    bucket ??= {
      start: Math.max(
        this.history.migration.cutover_at,
        Math.floor(now / period) * period,
      ),
      end: (Math.floor(now / period) + 1) * period,
      count: 0,
      cpu: 0,
      memory: 0,
      disk: 0,
    };
    bucket.count++;
    bucket.cpu += report.cpu.usagePercent;
    bucket.memory += report.memory.usagePercent;
    bucket.disk = Math.max(bucket.disk, maxDiskUsage(report));
    this.aggregates.set(id, bucket);
    this.broadcast(id, oldOrder !== this.publicIds().join(","));
    await this.schedule();
    return true;
  }
  private finish(id: string, bucket: Aggregate) {
    const queue = this.completed.get(id) ?? [];
    queue.push(bucket);
    if (queue.length > 10) {
      queue.shift();
      console.error("Analytics Engine history backlog truncated");
    }
    this.completed.set(id, queue);
    this.aggregates.delete(id);
  }
  async schedule() {
    const now = Date.now() / 1000;
    const active = [...this.configs.values()].some(
      (c) => c.enabled && this.presence.get(c.id)?.online,
    );
    if (
      active ||
      this.aggregates.size ||
      this.completed.size ||
      this.ctx
        .getWebSockets()
        .some(
          (ws) => (ws.deserializeAttachment() as Attachment).role === "admin",
        )
    ) {
      // One alarm per hub, no sample payload stored here.
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > (now + 5) * 1000)
        await this.ctx.storage.setAlarm(Math.ceil((now + 5) * 1000));
    }
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (new URL(request.url).pathname === "/history") {
      const url = new URL(request.url),
        id = url.searchParams.get("server") ?? "";
      if (!this.configs.has(id)) return json({ error: "服务器不存在" }, 404);
      try {
        return json(
          await this.history.read(
            id,
            url.searchParams.get("range") ?? "24h",
            this.preferences.retentionDays,
            this.configs.size,
            Date.now() / 1000,
          ),
        );
      } catch (error) {
        return error instanceof HttpError
          ? json({ error: error.message }, error.status)
          : json({ error: "历史数据暂时无法读取" }, 503);
      }
    }
    return this.exclusive(async () => {
      const path = new URL(request.url).pathname,
        now = Date.now() / 1000;
      if (path === "/refresh") {
        await this.load();
        for (const [id] of this.latest)
          if (!this.configs.get(id)?.enabled) this.latest.delete(id);
        for (const [id] of this.aggregates)
          if (!this.configs.get(id)?.enabled) this.aggregates.delete(id);
        for (const [id] of this.completed)
          if (!this.configs.has(id)) this.completed.delete(id);
        for (const c of this.configs.values())
          if (!c.enabled && this.presence.get(c.id)?.online)
            await this.transition(c.id, false, now);
        for (const ws of this.ctx.getWebSockets()) {
          const a = ws.deserializeAttachment() as Attachment,
            c = a.id ? this.configs.get(a.id) : null;
          if (a.role === "agent" && (!c?.enabled || c.token_hash !== a.hash))
            ws.close(4401, "Credential changed");
          if (
            a.role === "admin" &&
            request.headers.get("X-Close-Admins") === "1"
          )
            ws.close(4401, "Session changed");
        }
        this.broadcast();
        await this.schedule();
        return json({ ok: true });
      }
      if (path === "/overview") return json(this.overview(now));
      if (path === "/public") return json(this.publicOverview(now));
      if (path === "/ingest") {
        const raw = await readBody(request, 32768);
        if (raw === null) return json({ error: "Payload too large" }, 413);
        let report: unknown;
        try {
          report = JSON.parse(raw);
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (!validateReport(report, Math.floor(now)))
          return json({ error: "Invalid metrics or timestamp" }, 400);
        const c = this.configs.get(report.serverId),
          token = request.headers
            .get("Authorization")
            ?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
        if (
          !c?.enabled ||
          !c.token_hash ||
          !token ||
          !equal(await sha256(token), c.token_hash)
        )
          return json({ error: "Unauthorized" }, 401);
        const accepted = await this.accept(
          c.id,
          report,
          JSON.parse(request.headers.get("X-Network") ?? "null"),
          now,
        );
        return json({
          ok: true,
          accepted,
          interval: c.interval_seconds,
          serverTime: Math.floor(now),
        });
      }
      if (
        path !== "/connect" ||
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
      )
        return json({ error: "WebSocket required" }, 426);
      const role = request.headers.get("X-Role") as Attachment["role"];
      const a: Attachment = { role };
      if (role === "agent") {
        const id = request.headers.get("X-Server-Id") ?? "",
          c = this.configs.get(id),
          token = request.headers
            .get("Authorization")
            ?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
        if (
          !c?.enabled ||
          !c.token_hash ||
          !token ||
          !equal(await sha256(token), c.token_hash)
        )
          return json({ error: "Unauthorized" }, 401);
        if (c.interval_seconds > 10 || c.interval_seconds < 2) {
          await this.env.DB.prepare(
            "UPDATE servers SET interval_seconds = 5 WHERE id = ?",
          )
            .bind(id)
            .run();
          c.interval_seconds = 5;
        }
        a.id = id;
        a.hash = c.token_hash;
        a.network = JSON.parse(request.headers.get("X-Network") ?? "null");
        // Supersede an old connection without declaring an outage.
        for (const ws of this.ctx.getWebSockets("agent"))
          if ((ws.deserializeAttachment() as Attachment).id === id)
            ws.close(4000, "Replaced");
      } else if (role === "admin")
        a.expires = Number(request.headers.get("X-Expires"));
      else if (role !== "public") return json({ error: "Unauthorized" }, 401);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [role]);
      pair[1].serializeAttachment(a);
      if (role === "agent")
        this.send(pair[1], {
          type: "ready",
          interval: this.configs.get(a.id!)!.interval_seconds,
        });
      else
        this.send(pair[1], {
          type: "snapshot",
          data:
            role === "admin" ? this.overview(now) : this.publicOverview(now),
        });
      await this.schedule();
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ready;
    return this.exclusive(async () => {
      const a = ws.deserializeAttachment() as Attachment;
      if (message === "ping") {
        ws.send("pong");
        return;
      }
      if (a.role !== "agent") {
        ws.close(1008, "Read only");
        return;
      }
      const c = this.configs.get(a.id!);
      if (!c?.enabled || c.token_hash !== a.hash) {
        ws.close(4401, "Unauthorized");
        return;
      }
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).length > 32768
      ) {
        ws.close(1009, "Payload too large");
        return;
      }
      let report: unknown;
      try {
        report = JSON.parse(message);
      } catch {
        ws.close(1008, "Invalid JSON");
        return;
      }
      const now = Date.now() / 1000;
      if (
        !validateReport(report, Math.floor(now)) ||
        report.serverId !== a.id
      ) {
        ws.close(1008, "Invalid report");
        return;
      }
      const accepted = await this.accept(a.id, report, a.network ?? null, now);
      this.send(ws, {
        type: "ack",
        accepted,
        interval: c.interval_seconds,
        serverTime: Math.floor(now),
      });
    });
  }
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {}
  }
  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "Reconnect");
    } catch {}
  }
  async alarm() {
    await this.ready;
    return this.exclusive(async () => {
      const now = Date.now() / 1000;
      for (const c of this.configs.values()) {
        const live = this.latest.get(c.id),
          p = this.presence.get(c.id);
        const seen = live?.lastSeen ?? this.recoveredAt;
        if (p?.online && now - seen >= offlineSeconds(c.interval_seconds))
          await this.transition(
            c.id,
            false,
            seen + offlineSeconds(c.interval_seconds),
          );
        if (live && now - live.lastSeen >= c.interval_seconds * 2)
          this.broadcast(c.id);
      }
      for (const [id, bucket] of this.aggregates)
        if (now >= bucket.end) this.finish(id, bucket);
      let written = 0,
        probeId: string | undefined;
      for (const [id, queue] of this.completed) {
        while (queue.length && written < 240) {
          try {
            this.history.write(id, queue[0]);
          } catch {
            console.error("Analytics Engine history write failed; retrying");
            break;
          }
          queue.shift();
          written++;
          probeId = id;
        }
        if (!queue.length) this.completed.delete(id);
      }
      if (probeId) this.ctx.waitUntil(this.history.verify(probeId, now));
      for (const ws of this.ctx.getWebSockets("admin"))
        if (((ws.deserializeAttachment() as Attachment).expires ?? 0) <= now)
          ws.close(4401, "Session expired");
      await this.schedule();
    });
  }
}
