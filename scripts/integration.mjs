import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const directory = resolve(".local/integration");
await mkdir(directory, { recursive: true });
const setupKey = randomBytes(32).toString("hex");
const password = "integration-password-" + randomBytes(16).toString("hex");
const token = randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const config = {
  name: "status-integration",
  main: resolve("worker/index.ts"),
  compatibility_date: "2026-10-10",
  workers_dev: false,
  preview_urls: false,
  assets: {
    directory: resolve("dist"),
    binding: "ASSETS",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*"],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "integration-custom-name",
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: resolve("migrations"),
    },
  ],
};
await writeFile(`${directory}/wrangler.json`, JSON.stringify(config));
await writeFile(`${directory}/.dev.vars`, `SETUP_KEY=${setupKey}\n`, {
  mode: 0o600,
});
const persistence = `${directory}/state-${Date.now()}`;
const cli = resolve("node_modules/wrangler/bin/wrangler.js");
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const common = [
  "--config",
  `${directory}/wrangler.json`,
  "--persist-to",
  persistence,
];
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args, ...common], {
    encoding: "utf8",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || "Wrangler failed");
  return result.stdout;
}
function sql(statement) {
  // Credentials are written to a private SQL file, never to command arguments or logs.
  return writeFile(`${directory}/fixture.sql`, statement, { mode: 0o600 }).then(
    () =>
      command([
        "d1",
        "execute",
        "DB",
        "--local",
        "--file",
        `${directory}/fixture.sql`,
      ]),
  );
}
command(["d1", "migrations", "apply", "DB", "--local"]);
const child = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    ...common,
  ],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (chunk) => {
  logs += chunk;
});
child.stderr.on("data", (chunk) => {
  logs += chunk;
});
const origin = `http://127.0.0.1:${port}`;
async function request(
  path,
  { method = "GET", body, cookie, bearer, from = origin, headers = {} } = {},
) {
  return fetch(origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: from,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];
const codeOf = (result) => result.command.match(/--enroll ([a-z0-9]+)/)[1];
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      if ((await request("/api/session")).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, "Local Worker did not start: " + logs);
  const session = await (await request("/api/session")).json();
  assert.equal(session.setupRequired, true);
  const emptyPublic = await request("/api/public/uptime");
  assert.equal(emptyPublic.status, 200);
  assert.deepEqual((await emptyPublic.json()).servers, []);
  for (const path of [
    "/api/overview",
    "/api/settings",
    "/api/servers/example-server/history",
  ])
    assert.equal((await request(path)).status, 401);
  assert.equal(
    (
      await request("/api/servers", {
        method: "POST",
        body: { name: "Unauthorized" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/setup", {
        method: "POST",
        body: { setupKey, password },
        from: "https://other.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/setup", {
        method: "POST",
        body: { setupKey: "invalid", password },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/setup", {
        method: "POST",
        body: { setupKey, password: "short" },
      })
    ).status,
    400,
  );
  const initialized = await request("/api/setup", {
    method: "POST",
    body: { setupKey, password },
  });
  assert.equal(initialized.status, 201);
  let cookie = cookieOf(initialized);
  assert.equal(
    (
      await request("/api/setup", {
        method: "POST",
        body: { setupKey, password },
      })
    ).status,
    409,
  );
  assert.equal(
    (await (await request("/api/overview", { cookie })).json()).servers.length,
    0,
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { password },
        from: "https://other.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { password: "x".repeat(5000) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { password: "wrong" },
      })
    ).status,
    401,
  );
  const login = await request("/api/login", {
    method: "POST",
    body: { password },
  });
  assert.equal(login.status, 200);
  cookie = cookieOf(login);
  assert.equal(
    (
      await request("/api/servers", {
        method: "POST",
        cookie,
        body: { name: "", intervalSeconds: 60 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/servers", {
        method: "POST",
        cookie,
        body: { name: "Bad interval", intervalSeconds: 10 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/servers", {
        method: "POST",
        cookie,
        body: { name: "Cross-origin" },
        from: "https://other.example",
      })
    ).status,
    403,
  );
  const created = await request("/api/servers", {
    method: "POST",
    cookie,
    body: { name: "Example server", intervalSeconds: 60 },
  });
  assert.equal(created.status, 201);
  const server = await created.json();
  const other = await (
    await request("/api/servers", {
      method: "POST",
      cookie,
      body: { name: "Other server" },
    })
  ).json();
  assert(!server.command.includes(token));
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        body: { serverId: server.id, token },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(server),
        body: { serverId: other.id, token },
      })
    ).status,
    401,
  );
  const enrolled = await request("/api/enroll", {
    method: "POST",
    bearer: codeOf(server),
    body: { serverId: server.id, token },
  });
  assert.equal(enrolled.status, 200);
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(server),
        body: { serverId: server.id, token },
      })
    ).status,
    200,
    "A lost response must be recoverable with the same credential",
  );
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(server),
        body: { serverId: server.id, token: randomBytes(32).toString("hex") },
      })
    ).status,
    401,
  );
  await sql(
    `UPDATE enrollment_codes SET expires_at = 0 WHERE server_id = '${other.id}';`,
  );
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(other),
        body: { serverId: other.id, token },
      })
    ).status,
    401,
  );
  const replacement = await (
    await request(`/api/servers/${other.id}/install`, {
      method: "POST",
      cookie,
    })
  ).json();
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(other),
        body: { serverId: other.id, token },
      })
    ).status,
    401,
  );
  // Exercise the Python bootstrap against the actual Worker, including a repeated request.
  const bootstrap = spawn(
    process.env.STATUS_PYTHON || "python3",
    [
      resolve("agent/bootstrap.py"),
      "--url",
      origin,
      "--server",
      other.id,
      "--enroll",
      codeOf(replacement),
      "--pending",
      `${directory}/pending.json`,
      "--output",
      `${directory}/agent.json`,
      "--allow-local-http",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let bootstrapError = "";
  bootstrap.stderr.on("data", (chunk) => {
    bootstrapError += chunk;
  });
  assert.equal(
    await new Promise((resolve) => bootstrap.on("exit", resolve)),
    0,
    bootstrapError,
  );
  const agent = JSON.parse(await readFile(`${directory}/agent.json`, "utf8"));
  assert.equal(agent.serverId, other.id);
  assert.equal(agent.endpoint, origin + "/api/ingest");
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(replacement),
        body: { serverId: other.id, token: agent.token },
      })
    ).status,
    200,
  );
  const now = Math.floor(Date.now() / 1000);
  const sample = {
    version: 1,
    serverId: server.id,
    collectedAt: now,
    hostname: "integration-server",
    os: "Debian GNU/Linux",
    kernel: "test-kernel",
    architecture: "x86_64",
    cpu: { usagePercent: 32, cores: 2, load1: 0.2, load5: 0.1, load15: 0.1 },
    memory: {
      totalBytes: 1000,
      usedBytes: 400,
      availableBytes: 600,
      usagePercent: 40,
    },
    disks: [
      {
        mount: "/",
        device: "/dev/test",
        filesystem: "ext4",
        totalBytes: 1000,
        usedBytes: 300,
        availableBytes: 700,
        usagePercent: 30,
      },
      {
        mount: "/srv/private-data",
        device: "/dev/private-volume",
        filesystem: "ext4",
        totalBytes: 2000,
        usedBytes: 400,
        availableBytes: 1600,
        usagePercent: 20,
      },
    ],
    uptimeSeconds: 9999,
  };
  assert.equal(
    (await request("/api/ingest", { method: "POST", body: sample })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/ingest", {
        method: "POST",
        body: { extra: "x".repeat(40000) },
        bearer: token,
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request("/api/ingest", {
        method: "POST",
        body: { ...sample, serverId: other.id },
        bearer: token,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/ingest", {
        method: "POST",
        body: { ...sample, collectedAt: now - 121 },
        bearer: token,
      })
    ).status,
    400,
  );
  const accepted = await request("/api/ingest", {
    method: "POST",
    body: sample,
    bearer: token,
    // Miniflare's local-only header supplies deterministic request.cf metadata.
    headers: {
      "CF-Connecting-IP": "192.0.2.10",
      "MF-CF-Blob": JSON.stringify({ country: "JP", city: "Tokyo" }),
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).accepted, true);
  assert.equal(
    (
      await (
        await request("/api/ingest", {
          method: "POST",
          body: sample,
          bearer: token,
          headers: { "CF-Connecting-IP": "198.51.100.10" },
        })
      ).json()
    ).accepted,
    false,
  );
  assert.equal(
    (
      await (
        await request("/api/ingest", {
          method: "POST",
          body: { ...sample, collectedAt: now - 60 },
          bearer: token,
          headers: { "CF-Connecting-IP": "198.51.100.10" },
        })
      ).json()
    ).accepted,
    false,
  );
  const overview = await (await request("/api/overview", { cookie })).json();
  assert.equal(overview.servers.length, 2);
  const connection = overview.servers.find(
    (row) => row.id === server.id,
  ).network;
  assert.equal(
    connection.ip,
    "192.0.2.10",
    "Duplicate and stale reports must not replace connection metadata",
  );
  assert.equal(connection.country, "JP");
  assert.equal(connection.city, "Tokyo");
  const publicResponse = await request("/api/public/uptime");
  assert.equal(publicResponse.status, 200);
  const publicStatus = await publicResponse.json();
  assert.deepEqual(Object.keys(publicStatus).sort(), [
    "generatedAt",
    "servers",
  ]);
  assert.equal(publicStatus.servers.length, 2);
  const publicServer = publicStatus.servers.find((row) => row.country === "JP");
  assert.deepEqual(Object.keys(publicServer).sort(), [
    "city",
    "country",
    "cpuCores",
    "days",
    "diskTotalBytes",
    "memoryTotalBytes",
    "state",
    "uptimePercent",
    "uptimeSeconds",
  ]);
  assert.equal(publicServer.city, "Tokyo");
  assert.equal(publicServer.uptimeSeconds, 9999);
  assert.equal(publicServer.cpuCores, 2);
  assert.equal(publicServer.memoryTotalBytes, 1000);
  assert.equal(publicServer.diskTotalBytes, 3000);
  assert.equal(publicServer.state, "online");
  assert.equal(publicServer.days.length, 90);
  assert(
    publicServer.days.slice(0, -1).every((row) => row.uptimePercent === null),
  );
  assert.equal(
    publicStatus.servers.find((row) => row.country === null).state,
    "pending",
  );
  const serializedPublic = JSON.stringify(publicStatus);
  const pendingPublic = publicStatus.servers.find(
    (row) => row.country === null,
  );
  assert.equal(pendingPublic.cpuCores, null);
  assert.equal(pendingPublic.memoryTotalBytes, null);
  assert.equal(pendingPublic.diskTotalBytes, null);
  for (const privateValue of [
    server.id,
    other.id,
    "Example server",
    "integration-server",
    "192.0.2.10",
    token,
    codeOf(server),
    "test-kernel",
    "/srv/private-data",
    "/dev/private-volume",
  ])
    assert(
      !serializedPublic.includes(privateValue),
      "Public endpoint must omit private server details",
    );
  assert.equal((await request("/api/overview")).status, 401);
  assert.equal(
    overview.servers.find((row) => row.id === other.id).network,
    null,
  );
  assert.equal(
    overview.servers.find((row) => row.id === server.id).report.cpu
      .usagePercent,
    32,
  );
  assert.equal(
    overview.servers.find((row) => row.id === other.id).report,
    null,
  );
  assert(!JSON.stringify(overview).includes(token));
  assert(!JSON.stringify(overview).includes(codeOf(server)));
  // Renaming is private and updates only the name, leaving the public nodes,
  // collection settings, credentials and metric history intact.
  const renamePath = `/api/servers/${server.id}/name`;
  for (const authentication of [{}, { bearer: token }]) {
    assert.equal(
      (
        await request(renamePath, {
          method: "PATCH",
          body: { name: "Unauthorized rename" },
          ...authentication,
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await request(renamePath, {
        method: "PATCH",
        cookie,
        body: { name: "Cross-origin rename" },
        from: "https://other.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/servers/not-found/name", {
        method: "PATCH",
        cookie,
        body: { name: "Missing server" },
      })
    ).status,
    404,
  );
  for (const name of [
    undefined,
    null,
    123,
    "",
    "   ",
    "x".repeat(81),
    "bad\nname",
  ]) {
    assert.equal(
      (
        await request(renamePath, {
          method: "PATCH",
          cookie,
          body: { name },
        })
      ).status,
      400,
    );
  }
  const beforeRename = (
    await (await request("/api/overview", { cookie })).json()
  ).servers.find((row) => row.id === server.id);
  const beforeHistory = (
    await (
      await request(`/api/servers/${server.id}/history?range=1h`, { cookie })
    ).json()
  ).points;
  assert.equal(
    (
      await request(renamePath, {
        method: "PATCH",
        cookie,
        body: { name: "x".repeat(80) },
      })
    ).status,
    200,
  );
  const privateName = "东京 · 应用 VPS";
  const renamed = await request(renamePath, {
    method: "PATCH",
    cookie,
    body: {
      name: `  ${privateName}  `,
      enabled: false,
      intervalSeconds: 3600,
      sortOrder: 999,
    },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { name: privateName });
  const afterRename = (
    await (await request("/api/overview", { cookie })).json()
  ).servers.find((row) => row.id === server.id);
  assert.deepEqual(afterRename, { ...beforeRename, name: privateName });
  assert.deepEqual(
    (
      await (
        await request(`/api/servers/${server.id}/history?range=1h`, { cookie })
      ).json()
    ).points,
    beforeHistory,
  );
  const renamedPublic = await (await request("/api/public/uptime")).json();
  // Uptime percentages advance with wall time; compare the remaining fields
  // and node order directly, and check the public field allowlist again.
  const stablePublic = ({ uptimePercent, days, ...fields }) => ({
    ...fields,
    dates: days.map((day) => day.date),
  });
  assert.deepEqual(
    renamedPublic.servers.map(stablePublic),
    publicStatus.servers.map(stablePublic),
  );
  for (let index = 0; index < renamedPublic.servers.length; index++) {
    assert.deepEqual(
      Object.keys(renamedPublic.servers[index]).sort(),
      Object.keys(publicStatus.servers[index]).sort(),
    );
  }
  assert(!JSON.stringify(renamedPublic).includes(privateName));
  const moved = await request("/api/ingest", {
    method: "POST",
    body: { ...sample, collectedAt: now + 1 },
    bearer: token,
    headers: {
      "CF-Connecting-IP": "2001:db8::10",
      "MF-CF-Blob": JSON.stringify({ country: "SG", city: "Singapore" }),
    },
  });
  const movedResult = await moved.json();
  assert.equal(moved.status, 200, JSON.stringify(movedResult));
  assert.equal(movedResult.accepted, true);
  const movedOverview = await (
    await request("/api/overview", { cookie })
  ).json();
  assert.equal(
    movedOverview.servers.find((row) => row.id === server.id).network.ip,
    "2001:db8::10",
  );
  assert.equal(
    movedOverview.servers.find((row) => row.id === server.id).network.city,
    "Singapore",
  );
  const history = await (
    await request(`/api/servers/${server.id}/history?range=1h`, { cookie })
  ).json();
  assert.equal(history.points.length, 1);
  assert.equal(history.points[0].cpu, 32);
  assert.equal(
    (
      await request(`/api/servers/${server.id}/history?range=invalid`, {
        cookie,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/servers/not-found/history", { cookie })).status,
    404,
  );
  const updated = {
    name: "Renamed server",
    enabled: false,
    intervalSeconds: 300,
    sortOrder: 4,
  };
  assert.equal(
    (
      await request(`/api/servers/${server.id}`, {
        method: "PATCH",
        cookie,
        body: updated,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/ingest", {
        method: "POST",
        bearer: token,
        body: sample,
      })
    ).status,
    401,
  );
  // Disabled nodes are absent from the public response.
  assert.equal(
    (await (await request("/api/public/uptime")).json()).servers.length,
    1,
  );
  assert.equal(
    (
      await request("/api/enroll", {
        method: "POST",
        bearer: codeOf(server),
        body: { serverId: server.id, token },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(`/api/servers/${server.id}`, {
        method: "PATCH",
        cookie,
        body: { ...updated, enabled: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await (
        await request("/api/ingest", {
          method: "POST",
          bearer: token,
          body: sample,
        })
      ).json()
    ).interval,
    300,
  );
  const settings = {
    siteName: "Example monitor",
    warningPercent: 80,
    retentionDays: 3,
  };
  assert.equal(
    (
      await request("/api/settings", {
        method: "PATCH",
        cookie,
        body: { ...settings, retentionDays: 99 },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/settings", {
        method: "PATCH",
        cookie,
        body: settings,
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await (await request("/api/overview", { cookie })).json()).settings,
    settings,
  );
  assert.equal(
    (
      await request(`/api/servers/${server.id}/revoke`, {
        method: "POST",
        cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/ingest", {
        method: "POST",
        bearer: token,
        body: sample,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request(`/api/servers/${server.id}`, { method: "DELETE", cookie }))
      .status,
    200,
  );
  assert.equal(
    (await request(`/api/servers/${server.id}/history`, { cookie })).status,
    404,
  );
  const newPassword = password + "-changed";
  assert.equal(
    (
      await request("/api/password", {
        method: "POST",
        cookie,
        body: { currentPassword: "wrong", password: newPassword },
      })
    ).status,
    401,
  );
  const changed = await request("/api/password", {
    method: "POST",
    cookie,
    body: { currentPassword: password, password: newPassword },
  });
  assert.equal(changed.status, 200);
  assert.equal(
    (await request("/api/overview", { cookie })).status,
    401,
    "Password changes invalidate previous sessions",
  );
  cookie = cookieOf(changed);
  assert.equal(
    (await request("/api/login", { method: "POST", body: { password } }))
      .status,
    401,
  );
  const relogin = await request("/api/login", {
    method: "POST",
    body: { password: newPassword },
  });
  assert.equal(relogin.status, 200);
  cookie = cookieOf(relogin);
  for (let count = 0; count < 10; count++)
    assert.equal(
      (
        await request("/api/login", {
          method: "POST",
          body: { password: "wrong" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { password: "wrong" },
      })
    ).status,
    429,
  );
  assert.equal(
    (await request("/api/logout", { method: "POST", cookie })).status,
    200,
  );
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/admin")).status, 200);
  assert.equal((await request("/agent/install.sh")).status, 200);
  const manifest = await (await request("/agent/manifest.json")).json();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const asset = await request(`/agent/${manifest.version}/${name}`);
    assert.equal(asset.status, 200);
    assert.equal(hash(Buffer.from(await asset.arrayBuffer())), expected);
  }
  await writeFile(
    `${directory}/browser.json`,
    JSON.stringify({ password: newPassword, setupKey, origin, persistence }),
    { mode: 0o600 },
  );
  console.log(
    "Integration passed: public uptime privacy, homepage/admin routes, empty instance, protected setup, sessions, server management, enrollment retry/expiry/isolation, Python bootstrap, metrics/history, connection IP persistence/updates, revocation, password rotation, rate limits and versioned installer assets.",
  );
} finally {
  await writeFile(`${directory}/worker.log`, logs, { mode: 0o600 });
  child.kill("SIGTERM");
}
