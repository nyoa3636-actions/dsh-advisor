/**
 * Syntax-check every shipped JavaScript module without starting a Harness.
 * Runs `node --check` per file, which parses ESM without executing it.
 */
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function collect(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path, extension));
    else if (entry.name.endsWith(extension)) files.push(path);
  }
  return files;
}

const targets = [
  ...await collect(join(root, "dsh"), ".js"),
  ...await collect(join(root, "test"), ".mjs"),
  join(root, "scripts", "build-client.mjs"),
];

const failures = [];
for (const file of targets) {
  // Inherited stdio keeps the child's parser diagnostic visible without a pipe.
  const result = spawnSync(process.execPath, ["--check", file], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0 || result.error) {
    failures.push(`${relative(root, file)}${result.error ? `: ${result.error.message}` : ""}`);
  }
}

// A stale browser bundle would ship different code than this source tree.
const rebuild = spawnSync(process.execPath, [join(root, "scripts", "build-client.mjs"), "--check"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
if (rebuild.status !== 0 || rebuild.error) {
  failures.push(`dsh/client.js freshness check${rebuild.error ? `: ${rebuild.error.message}` : ""}`);
}

if (failures.length) {
  console.error(`check failed for ${failures.length} module(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`check ok: ${targets.length} modules parse as ESM`);
}
