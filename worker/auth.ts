export interface AuthEnv {
  SESSION_SECRET?: string;
  DASHBOARD_PASSWORD_HASH?: string;
  SETUP_KEY?: string;
}
const encoder = new TextEncoder();
const COOKIE = "status_session";

export function sessionSecret(env: AuthEnv): string {
  return env.SESSION_SECRET || env.SETUP_KEY || "";
}

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function legacyConfigured(env: AuthEnv): boolean {
  return (
    sessionSecret(env).length >= 32 &&
    /^[0-9a-f]{64}$/.test(env.DASHBOARD_PASSWORD_HASH || "")
  );
}

// Workers caps each native PBKDF2 call at 100,000 iterations. The server secret
// also peppers the password so a database dump alone cannot test guesses.
export async function passwordHash(
  password: string,
  env: AuthEnv,
  salt = randomToken(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${sessionSecret(env)}:${password}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  const hash = [...new Uint8Array(bits)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2-sha256:100000:${salt}:${hash}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
  env: AuthEnv,
): Promise<boolean> {
  const parts = stored.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "pbkdf2-sha256" ||
    parts[1] !== "100000" ||
    !/^[0-9a-f]{64}$/.test(parts[2]) ||
    !/^[0-9a-f]{64}$/.test(parts[3])
  )
    return false;
  return equal(await passwordHash(password, env, parts[2]), stored);
}

export async function sha256(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function equal(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++)
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function configured(env: AuthEnv): boolean {
  return (
    legacyConfigured(env) ||
    (sessionSecret(env).length >= 32 &&
      typeof env.SETUP_KEY === "string" &&
      env.SETUP_KEY.length >= 32)
  );
}

export async function authenticated(
  request: Request,
  env: AuthEnv,
  now = Math.floor(Date.now() / 1000),
  sessionVersion?: string,
): Promise<boolean> {
  if (sessionSecret(env).length < 32) return false;
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token || token.length > 200) return false;
  const parts = token.split(".");
  if (sessionVersion) {
    if (
      parts.length !== 4 ||
      parts[0] !== "v2" ||
      parts[2] !== sessionVersion ||
      !/^\d+$/.test(parts[1])
    )
      return false;
    const expires = Number(parts[1]);
    return (
      expires > now &&
      expires <= now + 86400 &&
      equal(
        parts[3],
        await sign(parts.slice(0, 3).join("."), sessionSecret(env)),
      )
    );
  }
  if (!legacyConfigured(env)) return false;
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d+$/.test(parts[1]))
    return false;
  const expires = Number(parts[1]);
  if (expires <= now || expires > now + 86400) return false;
  return equal(parts[2], await sign(`v1.${parts[1]}`, sessionSecret(env)));
}

export async function sessionCookie(
  request: Request,
  env: AuthEnv,
  now = Math.floor(Date.now() / 1000),
  sessionVersion?: string,
): Promise<string> {
  const payload = sessionVersion
    ? `v2.${now + 86400}.${sessionVersion}`
    : `v1.${now + 86400}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${payload}.${await sign(payload, sessionSecret(env))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`;
}

export function clearCookie(request: Request): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get("Origin") === new URL(request.url).origin;
}
