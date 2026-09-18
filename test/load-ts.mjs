import { execSync } from "node:child_process";
import { delimiter, join } from "node:path";
import Module from "node:module";
import { pathToFileURL } from "node:url";

const globalNodeModules = execSync("npm root -g", { encoding: "utf8" }).trim();
const piPackageDir = join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const jitiPath = join(piPackageDir, "node_modules", "jiti", "lib", "jiti.mjs");
const { createJiti } = await import(pathToFileURL(jitiPath).href);

process.env.NODE_PATH = [
	globalNodeModules,
	join(piPackageDir, "node_modules"),
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const jiti = createJiti(import.meta.url);

export function loadTs(path) {
	return jiti.import(path);
}
