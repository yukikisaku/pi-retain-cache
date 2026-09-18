import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const globalNodeModules = execSync("npm root -g", { encoding: "utf8" }).trim();
const componentPath = join(
	globalNodeModules,
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"modes",
	"interactive",
	"components",
	"custom-entry.js",
);
const { CustomEntryComponent } = await import(pathToFileURL(componentPath).href);

const entry = {
	type: "custom",
	id: "notice-update",
	parentId: null,
	timestamp: new Date(0).toISOString(),
	customType: "pi-cache-retain-notice-update",
	data: { periodId: "period-1", count: 2 },
};

test("rendererがundefinedならCustomEntryは空行を追加しない", () => {
	const component = new CustomEntryComponent(entry, () => undefined);
	assert.equal(component.hasContent(), false);
	assert.deepEqual(component.render(80), []);
});

test("rendererがcomponentを返す場合だけCustomEntryが間隔を追加する", () => {
	const child = { render: () => ["notice"], invalidate() {} };
	const component = new CustomEntryComponent(entry, () => child);
	assert.equal(component.hasContent(), true);
	assert.deepEqual(component.render(80), ["", "notice"]);
});
