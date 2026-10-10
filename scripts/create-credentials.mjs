import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
await mkdir(".local", { recursive: true, mode: 0o700 });
let credentials;
try {
  credentials = JSON.parse(await readFile(".local/credentials.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  credentials = { setupKey: randomBytes(32).toString("base64url") };
}
await writeFile(
  ".local/credentials.json",
  JSON.stringify(credentials, null, 2) + "\n",
  { mode: 0o600 },
);
// Preserve credentials of an existing installation; new instances use browser setup.
const vars =
  credentials.sessionSecret && credentials.password
    ? `SESSION_SECRET=${credentials.sessionSecret}\nDASHBOARD_PASSWORD_HASH=${createHash("sha256").update(credentials.password).digest("hex")}\n`
    : `SETUP_KEY=${credentials.setupKey}\n`;
await writeFile(".dev.vars", vars, { mode: 0o600 });
console.log(
  "本地凭证已保存至 .local/credentials.json，运行时 Secrets 已写入 .dev.vars。",
);
