import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-retain-cache-pack-"));

try {
  const packOutput = execFileSync(
    npmCommand,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", tempRoot],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  const [packResult] = JSON.parse(packOutput);
  assert.ok(packResult, "npm pack should produce one tarball");

  const packedFiles = packResult.files.map((file) => file.path);
  for (const required of [
    "config.json",
    "config.ts",
    "index.ts",
    "retain-controller.ts",
    "retain-notice-logic.ts",
    "retain-protocol.ts",
    "retain-renderer-logic.ts",
    "retain-renderer.ts",
    "README.md",
    "LICENSE",
    "package.json",
  ]) {
    assert.ok(packedFiles.includes(required), `packed file missing: ${required}`);
  }
  assert.equal(
    packedFiles.some((file) => file.startsWith("experiments/") || file.startsWith("test/") || file.startsWith("scripts/")),
    false,
    "private experiments, tests, and packaging scripts must not be packed",
  );

  const extractRoot = join(tempRoot, "extract");
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("tar", ["-xzf", packResult.filename, "-C", "extract"], {
    cwd: tempRoot,
    stdio: "pipe",
  });

  const packedRoot = join(extractRoot, "package");
  const manifest = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);

  const config = JSON.parse(readFileSync(join(packedRoot, "config.json"), "utf8"));
  assert.equal(config.enabled, true, "published default must keep cache retention enabled");
  assert.equal(config.intervalMinutes, 25);
  assert.equal(config.providerOverrides?.["claude-bridge"]?.intervalMinutes, 50);

  const renderer = readFileSync(join(packedRoot, "retain-renderer.ts"), "utf8");
  assert.equal(renderer.includes("modes/interactive/components/custom-entry"), false, "deep CustomEntry import must stay removed");
  assert.equal(renderer.includes("import.meta.resolve"), false, "renderer must not resolve Pi internals by path");

  const globalRoot = execFileSync(npmCommand, ["root", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
  const packageNodeModules = join(packageRoot, "node_modules");
  const executableNodeModules = join(dirname(process.execPath), "node_modules");
  const piPackageDir = [packageNodeModules, executableNodeModules, globalRoot]
    .map((root) => join(root, "@earendil-works", "pi-coding-agent"))
    .find(existsSync);
  assert.ok(piPackageDir, "@earendil-works/pi-coding-agent is required for the smoke test");

  const loaderPath = join(piPackageDir, "dist", "core", "extensions", "loader.js");
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions([join(packedRoot, "index.ts")], packedRoot);

  assert.deepEqual(loaded.errors, [], "Pi loader reported extension errors");
  assert.equal(loaded.extensions.length, 1, "Pi must load exactly one packed extension");

  console.log("Packed pi-retain-cache loaded successfully through Pi.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
