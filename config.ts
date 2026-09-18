import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(import.meta.dirname, "config.json");

export const INTERVAL_MINUTE_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50] as const;
export const MAX_IDLE_MINUTE_OPTIONS = [10, 20, 30, 40, 50, 60, 90, 120, 180, 240] as const;

export type ProviderTiming = {
	intervalMs?: number;
	maxIdleMs?: number;
};

export type CacheRetainConfig = {
	enabled: boolean;
	intervalMs: number;
	maxIdleMs: number;
	requestTimeoutMs: number;
	providers: string[];
	providerOverrides: Record<string, ProviderTiming>;
	showNotification: boolean;
};

export type ProviderTimingFile = {
	intervalMinutes?: unknown;
	maxIdleMinutes?: unknown;
};

export type CacheRetainConfigFile = {
	enabled?: unknown;
	intervalMinutes?: unknown;
	maxIdleMinutes?: unknown;
	requestTimeoutMinutes?: unknown;
	providers?: unknown;
	providerOverrides?: unknown;
	showNotification?: unknown;
};

export const DEFAULT_CONFIG: CacheRetainConfig = {
	enabled: true,
	intervalMs: 4 * 60_000,
	maxIdleMs: 30 * 60_000,
	requestTimeoutMs: 2 * 60_000,
	providers: ["openai-codex", "claude-bridge"],
	providerOverrides: {},
	showNotification: true,
};

function positiveMinutes(value: unknown, fallbackMs: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallbackMs;
	return value * 60_000;
}

function optionalMinutes(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value * 60_000;
}

function parseProviderOverrides(raw: unknown): Record<string, ProviderTiming> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const overrides: Record<string, ProviderTiming> = {};
	for (const [provider, value] of Object.entries(raw as Record<string, ProviderTimingFile>)) {
		if (!value || typeof value !== "object") continue;
		const intervalMs = optionalMinutes(value.intervalMinutes);
		const maxIdleMs = optionalMinutes(value.maxIdleMinutes);
		if (intervalMs === undefined && maxIdleMs === undefined) continue;
		if (intervalMs !== undefined && maxIdleMs !== undefined && maxIdleMs <= intervalMs) {
			throw new Error(`Provider "${provider}": maximum idle time must be greater than the interval.`);
		}
		overrides[provider] = {
			...(intervalMs !== undefined ? { intervalMs } : {}),
			...(maxIdleMs !== undefined ? { maxIdleMs } : {}),
		};
	}
	return overrides;
}

export function parseConfig(parsed: CacheRetainConfigFile): CacheRetainConfig {
	const providers = Array.isArray(parsed.providers)
		? parsed.providers
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.map((value) => value.trim())
		: DEFAULT_CONFIG.providers;

	const intervalMs = positiveMinutes(parsed.intervalMinutes, DEFAULT_CONFIG.intervalMs);
	const maxIdleMs = positiveMinutes(parsed.maxIdleMinutes, DEFAULT_CONFIG.maxIdleMs);
	const requestTimeoutMs = positiveMinutes(parsed.requestTimeoutMinutes, DEFAULT_CONFIG.requestTimeoutMs);
	if (providers.length === 0) {
		throw new Error("At least one provider is required.");
	}
	if (maxIdleMs <= intervalMs) {
		throw new Error("Maximum idle time must be greater than the interval.");
	}

	return {
		enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
		intervalMs,
		maxIdleMs,
		requestTimeoutMs,
		providers: [...providers],
		providerOverrides: parseProviderOverrides(parsed.providerOverrides),
		showNotification:
			typeof parsed.showNotification === "boolean"
				? parsed.showNotification
				: DEFAULT_CONFIG.showNotification,
	};
}

export type ResolvedTiming = {
	intervalMs: number;
	maxIdleMs: number;
};

// プロバイダーごとの実効タイミングを決める。providerOverridesがあればそれを、
// なければトップレベルの値を使う。
// maxIdleがintervalより短くなる組み合わせは、最低でも interval+1分 に引き上げる。
export function resolveProviderTiming(
	config: CacheRetainConfig,
	provider: string | undefined,
): ResolvedTiming {
	const override = provider ? config.providerOverrides?.[provider] : undefined;
	const intervalMs = override?.intervalMs ?? config.intervalMs;
	const maxIdleMs = Math.max(override?.maxIdleMs ?? config.maxIdleMs, intervalMs + 60_000);
	return { intervalMs, maxIdleMs };
}

export function serializeConfig(config: CacheRetainConfig): Required<CacheRetainConfigFile> {
	const providerOverrides: Record<string, ProviderTimingFile> = {};
	for (const [provider, timing] of Object.entries(config.providerOverrides)) {
		providerOverrides[provider] = {
			...(timing.intervalMs !== undefined ? { intervalMinutes: timing.intervalMs / 60_000 } : {}),
			...(timing.maxIdleMs !== undefined ? { maxIdleMinutes: timing.maxIdleMs / 60_000 } : {}),
		};
	}
	return {
		enabled: config.enabled,
		intervalMinutes: config.intervalMs / 60_000,
		maxIdleMinutes: config.maxIdleMs / 60_000,
		requestTimeoutMinutes: config.requestTimeoutMs / 60_000,
		providers: [...config.providers],
		providerOverrides,
		showNotification: config.showNotification,
	};
}

export function loadConfig(): CacheRetainConfig {
	if (!existsSync(CONFIG_PATH)) {
		return { ...DEFAULT_CONFIG, providers: [...DEFAULT_CONFIG.providers], providerOverrides: {} };
	}
	return parseConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as CacheRetainConfigFile);
}

export function saveConfig(config: CacheRetainConfig): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify(serializeConfig(config), null, 2)}\n`, "utf8");
}
