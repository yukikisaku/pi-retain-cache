import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./load-ts.mjs";

const {
	DEFAULT_CONFIG,
	INTERVAL_MINUTE_OPTIONS,
	MAX_IDLE_MINUTE_OPTIONS,
	parseConfig,
	resolveProviderTiming,
	serializeConfig,
} = await loadTs("../config.ts");

test("既定値は4分間隔・最大30分・通知あり", () => {
	assert.equal(DEFAULT_CONFIG.intervalMs, 4 * 60_000);
	assert.equal(DEFAULT_CONFIG.maxIdleMs, 30 * 60_000);
	assert.equal(DEFAULT_CONFIG.showNotification, true);
});

test("設定画面の候補値を固定する", () => {
	assert.deepEqual([...INTERVAL_MINUTE_OPTIONS], [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50]);
	assert.deepEqual([...MAX_IDLE_MINUTE_OPTIONS], [10, 20, 30, 40, 50, 60, 90, 120, 180, 240]);
});

test("showNotificationを含む設定を読み書きできる", () => {
	const parsed = parseConfig({
		enabled: true,
		intervalMinutes: 2,
		maxIdleMinutes: 20,
		requestTimeoutMinutes: 3,
		providers: [" openai-codex "],
		showNotification: false,
	});
	assert.deepEqual(parsed, {
		enabled: true,
		intervalMs: 2 * 60_000,
		maxIdleMs: 20 * 60_000,
		requestTimeoutMs: 3 * 60_000,
		providers: ["openai-codex"],
		providerOverrides: {},
		showNotification: false,
	});
	assert.deepEqual(serializeConfig(parsed), {
		enabled: true,
		intervalMinutes: 2,
		maxIdleMinutes: 20,
		requestTimeoutMinutes: 3,
		providers: ["openai-codex"],
		providerOverrides: {},
		showNotification: false,
	});
});

test("プロバイダー別overrideを読み書きできる", () => {
	const parsed = parseConfig({
		providerOverrides: {
			"claude-bridge": { intervalMinutes: 50, maxIdleMinutes: 120 },
			"openai-codex": { intervalMinutes: 3 },
			ignored: {},
		},
	});
	assert.deepEqual(parsed.providerOverrides, {
		"claude-bridge": { intervalMs: 50 * 60_000, maxIdleMs: 120 * 60_000 },
		"openai-codex": { intervalMs: 3 * 60_000 },
	});
	assert.deepEqual(serializeConfig(parsed).providerOverrides, {
		"claude-bridge": { intervalMinutes: 50, maxIdleMinutes: 120 },
		"openai-codex": { intervalMinutes: 3 },
	});
});

test("overrideのmaxIdleがinterval以下なら拒否する", () => {
	assert.throws(
		() => parseConfig({ providerOverrides: { "claude-bridge": { intervalMinutes: 50, maxIdleMinutes: 50 } } }),
		/maximum idle time must be greater than the interval/,
	);
});

test("実効タイミングの優先順位: override > 既定値", () => {
	const base = { ...DEFAULT_CONFIG, providerOverrides: {} };

	// 既定値
	assert.deepEqual(resolveProviderTiming(base, "openai-codex"), {
		intervalMs: DEFAULT_CONFIG.intervalMs,
		maxIdleMs: DEFAULT_CONFIG.maxIdleMs,
	});
	assert.deepEqual(resolveProviderTiming(base, undefined), {
		intervalMs: DEFAULT_CONFIG.intervalMs,
		maxIdleMs: DEFAULT_CONFIG.maxIdleMs,
	});

	// 明示的overrideはトップレベルの値より優先
	const withOverride = {
		...base,
		providerOverrides: { "claude-bridge": { intervalMs: 10 * 60_000, maxIdleMs: 60 * 60_000 } },
	};
	assert.deepEqual(resolveProviderTiming(withOverride, "claude-bridge"), {
		intervalMs: 10 * 60_000,
		maxIdleMs: 60 * 60_000,
	});
});

test("intervalだけoverrideした場合はmaxIdleをinterval+1分に引き上げる", () => {
	const config = {
		...DEFAULT_CONFIG,
		providerOverrides: { "openai-codex": { intervalMs: 50 * 60_000 } },
	};
	assert.deepEqual(resolveProviderTiming(config, "openai-codex"), {
		intervalMs: 50 * 60_000,
		maxIdleMs: 51 * 60_000,
	});
});

test("旧showNoticeキーは設定として採用しない", () => {
	const parsed = parseConfig({ showNotice: false });
	assert.equal(parsed.showNotification, true);
});

test("最大時間が間隔以下なら拒否する", () => {
	assert.throws(
		() => parseConfig({ intervalMinutes: 10, maxIdleMinutes: 10 }),
		/Maximum idle time must be greater than the interval/,
	);
});
