import { randomToken, sha256 } from "./auth";
import { HttpError, json, readJSON } from "./http";
import { type AdminEnv } from "./administrator";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";

export async function settings(env: AdminEnv): Promise<Settings> {
  const row = await env.DB.prepare(
    "SELECT site_name, warning_percent, retention_days FROM settings WHERE id = 1",
  ).first<{
    site_name: string;
    warning_percent: number;
    retention_days: number;
  }>();
  return row
    ? {
        siteName: row.site_name,
        warningPercent: row.warning_percent,
        retentionDays: row.retention_days,
      }
    : DEFAULT_SETTINGS;
}

function name(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new HttpError(400, "名称需为 1–80 个字符");
}
function interval(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 30 ||
    value > 3600
  )
    throw new HttpError(400, "采集间隔需为 30–3600 秒");
}
export async function updateSettings(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  const body = await readJSON(request);
  name(body.siteName);
  if (
    typeof body.warningPercent !== "number" ||
    !Number.isInteger(body.warningPercent) ||
    body.warningPercent < 1 ||
    body.warningPercent > 100
  )
    throw new HttpError(400, "占用阈值需为 1–100%");
  if (
    typeof body.retentionDays !== "number" ||
    !Number.isInteger(body.retentionDays) ||
    body.retentionDays < 1 ||
    body.retentionDays > 30
  )
    throw new HttpError(400, "历史保留需为 1–30 天");
  await env.DB.prepare(
    "UPDATE settings SET site_name = ?, warning_percent = ?, retention_days = ? WHERE id = 1",
  )
    .bind(body.siteName.trim(), body.warningPercent, body.retentionDays)
    .run();
  return json(await settings(env));
}

export async function createServer(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<Response> {
  const body = await readJSON(request);
  name(body.name);
  const seconds = body.intervalSeconds ?? 60;
  interval(seconds);
  const id = crypto.randomUUID();
  const code = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO servers (id, name, sort_order, interval_seconds) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM servers), ?)",
    ).bind(id, body.name.trim(), seconds),
    env.DB.prepare(
      "INSERT INTO enrollment_codes (server_id, code_hash, expires_at) VALUES (?, ?, ?)",
    ).bind(id, await sha256(code), now + 600),
  ]);
  const server = await env.DB.prepare(
    "SELECT sort_order FROM servers WHERE id = ?",
  )
    .bind(id)
    .first<{ sort_order: number }>();
  return json(
    {
      id,
      sortOrder: server!.sort_order,
      ...installation(request, id, code, now),
    },
    201,
  );
}

function installation(request: Request, id: string, code: string, now: number) {
  const origin = new URL(request.url).origin;
  // All shell arguments are generated/validated; origin is quoted separately.
  const quotedOrigin = `'${origin.replaceAll("'", "'\\''")}'`;
  return {
    command: `curl -fsS ${quotedOrigin}/agent/install.sh | sh -s -- --url ${quotedOrigin} --server ${id} --enroll ${code}`,
    expiresAt: now + 600,
  };
}

async function serverExists(env: AdminEnv, id: string) {
  if (
    !(await env.DB.prepare("SELECT id FROM servers WHERE id = ?")
      .bind(id)
      .first())
  )
    throw new HttpError(404, "服务器不存在");
}

export async function installCommand(
  request: Request,
  env: AdminEnv,
  id: string,
  now: number,
): Promise<Response> {
  await serverExists(env, id);
  const code = randomToken();
  await env.DB.prepare(
    `INSERT INTO enrollment_codes (server_id, code_hash, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, redeemed_token_hash = NULL, redeemed_at = NULL`,
  )
    .bind(id, await sha256(code), now + 600)
    .run();
  return json(installation(request, id, code, now));
}

export async function updateServer(
  request: Request,
  env: AdminEnv,
  id: string,
): Promise<Response> {
  await serverExists(env, id);
  const body = await readJSON(request);
  name(body.name);
  interval(body.intervalSeconds);
  if (
    typeof body.enabled !== "boolean" ||
    typeof body.sortOrder !== "number" ||
    !Number.isInteger(body.sortOrder) ||
    body.sortOrder < 0 ||
    body.sortOrder > 1000000
  )
    throw new HttpError(400, "服务器设置无效");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE servers SET name = ?, interval_seconds = ?, enabled = ?, sort_order = ? WHERE id = ?",
    ).bind(
      body.name.trim(),
      body.intervalSeconds,
      Number(body.enabled),
      body.sortOrder,
      id,
    ),
    ...(body.enabled
      ? []
      : [
          env.DB.prepare(
            "DELETE FROM enrollment_codes WHERE server_id = ?",
          ).bind(id),
        ]),
  ]);
  return json({ ok: true });
}

export async function renameServer(
  request: Request,
  env: AdminEnv,
  id: string,
): Promise<Response> {
  await serverExists(env, id);
  const body = await readJSON(request);
  name(body.name);
  const renamed = body.name.trim();
  await env.DB.prepare("UPDATE servers SET name = ? WHERE id = ?")
    .bind(renamed, id)
    .run();
  return json({ name: renamed });
}

export async function revokeServer(
  env: AdminEnv,
  id: string,
): Promise<Response> {
  await serverExists(env, id);
  await env.DB.batch([
    env.DB.prepare("UPDATE servers SET token_hash = NULL WHERE id = ?").bind(
      id,
    ),
    env.DB.prepare("DELETE FROM enrollment_codes WHERE server_id = ?").bind(id),
  ]);
  return json({ ok: true });
}

export async function deleteServer(
  env: AdminEnv,
  id: string,
): Promise<Response> {
  await serverExists(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM enrollment_codes WHERE server_id = ?").bind(id),
    env.DB.prepare("DELETE FROM metrics WHERE server_id = ?").bind(id),
    env.DB.prepare("DELETE FROM snapshots WHERE server_id = ?").bind(id),
    env.DB.prepare("DELETE FROM uptime_intervals WHERE server_id = ?").bind(id),
    env.DB.prepare("DELETE FROM uptime_tracking WHERE server_id = ?").bind(id),
    env.DB.prepare("DELETE FROM servers WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

export async function enroll(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<Response> {
  const code = request.headers
    .get("Authorization")
    ?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (!code) throw new HttpError(401, "接入码无效或已过期");
  const body = await readJSON(request);
  if (
    typeof body.serverId !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(body.serverId) ||
    typeof body.token !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(body.token)
  )
    throw new HttpError(400, "接入请求无效");
  const codeHash = await sha256(code);
  const tokenHash = await sha256(body.token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE enrollment_codes SET redeemed_token_hash = ?, redeemed_at = COALESCE(redeemed_at, ?)
      WHERE server_id = ? AND code_hash = ? AND expires_at > ?
      AND (redeemed_token_hash IS NULL OR redeemed_token_hash = ?)`,
    ).bind(tokenHash, now, body.serverId, codeHash, now, tokenHash),
    env.DB.prepare(
      `UPDATE servers SET token_hash = ?, enabled = 1 WHERE id = ?
      AND EXISTS (SELECT 1 FROM enrollment_codes WHERE server_id = ? AND code_hash = ? AND expires_at > ? AND redeemed_token_hash = ?)`,
    ).bind(tokenHash, body.serverId, body.serverId, codeHash, now, tokenHash),
  ]);
  if (!results[1].meta.changes)
    throw new HttpError(401, "接入码无效、已过期或已使用");
  const server = await env.DB.prepare(
    "SELECT interval_seconds FROM servers WHERE id = ?",
  )
    .bind(body.serverId)
    .first<{ interval_seconds: number }>();
  return json({
    ok: true,
    serverId: body.serverId,
    interval: server!.interval_seconds,
  });
}
