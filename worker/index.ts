import { sameOrigin, clearCookie, type AuthEnv } from "./auth";
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
  renameServer,
  revokeServer,
  deleteServer,
  enroll,
} from "./management";
import { requestNetwork } from "./network";
import { DAY_SECONDS, UPTIME_DAYS } from "../shared/uptime";
import { hub, type RealtimeEnv } from "./realtime";
export { RealtimeHub } from "./realtime";

interface Env extends AuthEnv, RealtimeEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}
async function changed(
  response: Promise<Response>,
  env: Env,
  closeAdmins = false,
) {
  const result = await response;
  if (result.ok) {
    const refresh = await hub(env).fetch(
      new Request("https://hub/refresh", {
        method: "POST",
        headers: { "X-Close-Admins": closeAdmins ? "1" : "0" },
      }),
    );
    if (!refresh.ok) throw new Error("Realtime configuration refresh failed");
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Math.floor(Date.now() / 1000);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (request.method === "GET" && url.pathname === "/api/public/uptime")
        return await hub(env).fetch("https://hub/public");
      if (request.method === "POST" && url.pathname === "/api/enroll")
        return await changed(enroll(request, env, now), env);
      if (request.method === "POST" && url.pathname === "/api/setup")
        return await setup(request, env, now);
      if (request.method === "POST" && url.pathname === "/api/ingest") {
        const authorization = request.headers.get("Authorization") ?? "";
        if (!/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization))
          return json({ error: "Unauthorized" }, 401);
        const raw = await readBody(request, 32768);
        if (raw === null) return json({ error: "Payload too large" }, 413);
        return await hub(env).fetch(
          new Request("https://hub/ingest", {
            method: "POST",
            headers: {
              Authorization: authorization,
              "X-Network": JSON.stringify(requestNetwork(request)),
            },
            body: raw,
          }),
        );
      }
      if (
        request.method === "GET" &&
        ["/api/agent/connect", "/api/public/live", "/api/live"].includes(
          url.pathname,
        )
      ) {
        if (url.search)
          return json({ error: "Query parameters are not accepted" }, 400);
        const agent = url.pathname === "/api/agent/connect";
        const admin = url.pathname === "/api/live";
        if (!agent && !sameOrigin(request))
          return json({ error: "请求来源无效" }, 403);
        if (admin && !(await authorized(request, env, now)))
          return json({ error: "请先登录" }, 401);
        const headers = new Headers({
          Upgrade: "websocket",
          "X-Role": agent ? "agent" : admin ? "admin" : "public",
        });
        if (agent) {
          headers.set(
            "Authorization",
            request.headers.get("Authorization") ?? "",
          );
          headers.set("X-Server-Id", request.headers.get("X-Server-Id") ?? "");
          headers.set("X-Network", JSON.stringify(requestNetwork(request)));
        }
        if (admin) {
          const cookie = request.headers
            .get("Cookie")
            ?.match(/(?:^|;\s*)status_session=v[12]\.(\d+)/);
          headers.set("X-Expires", cookie?.[1] ?? String(now));
        }
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return json({ error: "WebSocket required" }, 426);
        return await hub(env).fetch(
          new Request("https://hub/connect", { headers }),
        );
      }
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
        return await changed(changePassword(request, env, now), env, true);
      if (request.method === "GET" && url.pathname === "/api/settings")
        return json(await settings(env));
      if (request.method === "PATCH" && url.pathname === "/api/settings")
        return await changed(updateSettings(request, env), env);
      if (request.method === "POST" && url.pathname === "/api/servers")
        return await changed(createServer(request, env, now), env);
      const managed = url.pathname.match(
        /^\/api\/servers\/([a-z0-9-]{1,64})(?:\/(install|revoke|name))?$/,
      );
      if (managed) {
        if (request.method === "POST" && managed[2] === "install")
          return await changed(
            installCommand(request, env, managed[1], now),
            env,
          );
        if (request.method === "POST" && managed[2] === "revoke")
          return await changed(revokeServer(env, managed[1]), env);
        if (request.method === "PATCH" && managed[2] === "name")
          return await changed(renameServer(request, env, managed[1]), env);
        if (request.method === "PATCH" && !managed[2])
          return await changed(updateServer(request, env, managed[1]), env);
        if (request.method === "DELETE" && !managed[2])
          return await changed(deleteServer(env, managed[1]), env);
      }
      if (request.method === "POST" && url.pathname === "/api/logout") {
        if (!sameOrigin(request)) return json({ error: "请求来源无效" }, 403);
        return await changed(
          Promise.resolve(
            json({ ok: true }, 200, { "Set-Cookie": clearCookie(request) }),
          ),
          env,
          true,
        );
      }
      if (request.method === "GET" && url.pathname === "/api/overview")
        return await hub(env).fetch("https://hub/overview");
      const match = url.pathname.match(
        /^\/api\/servers\/([a-z0-9-]+)\/history$/,
      );
      if (request.method === "GET" && match)
        return await hub(env).fetch(
          `https://hub/history?server=${encodeURIComponent(match[1])}&range=${encodeURIComponent(url.searchParams.get("range") ?? "24h")}`,
        );
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
    await env.DB.batch([
      env.DB.prepare("DELETE FROM enrollment_codes WHERE expires_at <= ?").bind(
        now,
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
