import {
  authenticated,
  equal,
  legacyConfigured,
  passwordHash,
  randomToken,
  sameOrigin,
  sessionCookie,
  sessionSecret,
  sha256,
  verifyPassword,
  type AuthEnv,
} from "./auth";
import { HttpError, json, readJSON } from "./http";

export interface AdminEnv extends AuthEnv {
  DB: D1Database;
}
export interface Administrator {
  password_hash: string;
  session_version: string;
}
export const administrator = (env: AdminEnv) =>
  env.DB.prepare(
    "SELECT password_hash, session_version FROM administrator WHERE id = 1",
  ).first<Administrator>();

export async function authorized(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<boolean> {
  const admin = await administrator(env);
  return authenticated(request, env, now, admin?.session_version);
}

function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new HttpError(400, "密码需为 12–256 个字符");
}

async function attemptAddress(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<string> {
  const address = await sha256(
    `${sessionSecret(env)}:${request.headers.get("CF-Connecting-IP") || "local"}`,
  );
  // Reserve an attempt before expensive password verification, including concurrent requests.
  await env.DB.prepare(
    `INSERT INTO login_attempts (address_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(address_hash) DO UPDATE SET
    attempts = CASE WHEN ? - window_start >= 900 THEN 1 ELSE attempts + 1 END,
    window_start = CASE WHEN ? - window_start >= 900 THEN ? ELSE window_start END`,
  )
    .bind(address, now, now, now, now)
    .run();
  const row = await env.DB.prepare(
    "SELECT window_start, attempts FROM login_attempts WHERE address_hash = ?",
  )
    .bind(address)
    .first<{ window_start: number; attempts: number }>();
  if (row && row.attempts > 10)
    throw new HttpError(429, "尝试次数过多，请稍后再试");
  return address;
}

export async function setup(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<Response> {
  if (!sameOrigin(request)) throw new HttpError(403, "请求来源无效");
  if ((await administrator(env)) || legacyConfigured(env))
    throw new HttpError(409, "面板已初始化，请登录");
  if (
    !env.SETUP_KEY ||
    env.SETUP_KEY.length < 32 ||
    sessionSecret(env).length < 32
  )
    throw new HttpError(503, "请先配置 SETUP_KEY");
  const address = await attemptAddress(request, env, now);
  const body = await readJSON(request);
  if (typeof body.setupKey !== "string" || !equal(body.setupKey, env.SETUP_KEY))
    throw new HttpError(401, "初始化密钥不正确");
  validatePassword(body.password);
  const version = randomToken();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO administrator (id, password_hash, session_version) VALUES (1, ?, ?)",
  )
    .bind(await passwordHash(body.password, env), version)
    .run();
  if (!result.meta.changes) throw new HttpError(409, "面板已初始化，请登录");
  await env.DB.prepare("DELETE FROM login_attempts WHERE address_hash = ?")
    .bind(address)
    .run();
  return json({ ok: true }, 201, {
    "Set-Cookie": await sessionCookie(request, env, now, version),
  });
}

export async function login(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<Response> {
  if (!sameOrigin(request)) throw new HttpError(403, "请求来源无效");
  let admin = await administrator(env);
  if (sessionSecret(env).length < 32 || (!admin && !legacyConfigured(env)))
    throw new HttpError(503, "请先初始化面板");
  const body = await readJSON(request);
  if (typeof body.password !== "string" || body.password.length > 256)
    throw new HttpError(400, "请求格式无效");
  const address = await attemptAddress(request, env, now);
  const valid = admin
    ? await verifyPassword(body.password, admin.password_hash, env)
    : equal(await sha256(body.password), env.DASHBOARD_PASSWORD_HASH!);
  if (!valid) throw new HttpError(401, "访问密码不正确");
  if (!admin) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO administrator (id, password_hash, session_version) VALUES (1, ?, ?)",
    )
      .bind(await passwordHash(body.password, env), randomToken())
      .run();
    admin = await administrator(env);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE address_hash = ?")
    .bind(address)
    .run();
  return json({ ok: true }, 200, {
    "Set-Cookie": await sessionCookie(
      request,
      env,
      now,
      admin!.session_version,
    ),
  });
}

export async function changePassword(
  request: Request,
  env: AdminEnv,
  now: number,
): Promise<Response> {
  const body = await readJSON(request);
  validatePassword(body.password);
  const address = await attemptAddress(request, env, now);
  const admin = await administrator(env);
  if (
    typeof body.currentPassword !== "string" ||
    body.currentPassword.length > 256 ||
    !(admin
      ? await verifyPassword(body.currentPassword, admin.password_hash, env)
      : equal(
          await sha256(body.currentPassword),
          env.DASHBOARD_PASSWORD_HASH || "",
        ))
  )
    throw new HttpError(401, "当前密码不正确");
  const version = randomToken();
  await env.DB.prepare(
    `INSERT INTO administrator (id, password_hash, session_version) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, session_version = excluded.session_version`,
  )
    .bind(await passwordHash(body.password, env), version)
    .run();
  await env.DB.prepare("DELETE FROM login_attempts WHERE address_hash = ?")
    .bind(address)
    .run();
  return json({ ok: true }, 200, {
    "Set-Cookie": await sessionCookie(request, env, now, version),
  });
}
