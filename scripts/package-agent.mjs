import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = ["status_agent.py", "status-agent.service", "bootstrap.py"];
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(`agent/${file}`))
        .digest("hex"),
    ]),
  ),
);
const version =
  "0.2.0-" +
  createHash("sha256")
    .update(JSON.stringify(hashes))
    .digest("hex")
    .slice(0, 12);
await mkdir(`dist/agent/${version}`, { recursive: true });
for (const file of files)
  await copyFile(`agent/${file}`, `dist/agent/${version}/${file}`);
await copyFile("agent/install.sh", "dist/agent/install.sh");
await writeFile(
  "dist/agent/manifest.json",
  JSON.stringify({ version, files: hashes }) + "\n",
);
