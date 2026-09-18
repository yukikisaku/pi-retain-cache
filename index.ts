import { randomUUID } from "node:crypto";
import {
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	DEFAULT_CONFIG,
	INTERVAL_MINUTE_OPTIONS,
	loadConfig,
	MAX_IDLE_MINUTE_OPTIONS,
	resolveProviderTiming,
	saveConfig,
	type CacheRetainConfig,
} from "./config.js";
import { RetainController } from "./retain-controller.js";
import {
	classifyRetainResponse,
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	RETAIN_REQUEST,
	RETAIN_REQUEST_CUSTOM_TYPE,
	type RetainNoticeData,
	type RetainNoticeUpdateData,
} from "./retain-protocol.js";
import {
	clearRetainNoticeState,
	hydrateRetainNoticeState,
	installRetainRendererPatches,
	recordRetainNoticeCount,
	registerRetainNoticeRenderer,
	setRetainNotificationVisible,
	setRetainRenderingActive,
	uninstallRetainRendererPatches,
} from "./retain-renderer.js";

type SettingId =
	| { kind: "showNotification" }
	| { kind: "interval"; provider: string }
	| { kind: "maxIdle"; provider: string };

type SettingRow = {
	id: SettingId;
	label: string;
	values: string[];
	valueIndex: number;
};

function cloneConfig(config: CacheRetainConfig): CacheRetainConfig {
	const providerOverrides: CacheRetainConfig["providerOverrides"] = {};
	for (const [provider, timing] of Object.entries(config.providerOverrides)) {
		providerOverrides[provider] = { ...timing };
	}
	return { ...config, providers: [...config.providers], providerOverrides };
}

function minuteLabel(minutes: number): string {
	return `${minutes} min`;
}

// "auto" はoverrideなし(claude-bridgeはTTL検出、それ以外は既定値)を意味する
const AUTO_VALUE = "auto";

function timingValueLabel(overrideMs: number | undefined): string {
	return overrideMs === undefined ? AUTO_VALUE : minuteLabel(overrideMs / 60_000);
}

export default function piCacheRetain(pi: ExtensionAPI): void {
	installRetainRendererPatches();
	registerRetainNoticeRenderer(pi);

	let controller: RetainController | undefined;
	let config: CacheRetainConfig | undefined;
	let latestContext: ExtensionContext | undefined;
	let activeNoticePeriodId: string | undefined;

	function rememberContext(ctx: ExtensionContext): void {
		latestContext = ctx;
	}

	function createController(ctx: ExtensionContext): RetainController | undefined {
		if (ctx.mode !== "tui") return undefined;

		try {
			config = loadConfig();
		} catch (error) {
			ctx.ui.notify(
				`pi-cache-retain: Failed to load config.json: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return undefined;
		}

		setRetainNotificationVisible(config.showNotification);
		return new RetainController(config, {
			resolveTiming: (provider) => resolveProviderTiming(config ?? DEFAULT_CONFIG, provider),
			getRuntime: () => {
				const draft = latestContext?.ui.getEditorText().trim() ?? "";
				return {
					isIdle: (latestContext?.isIdle() ?? false) && draft.length === 0,
					hasPendingMessages: latestContext?.hasPendingMessages() ?? false,
					provider: latestContext?.model?.provider,
				};
			},
			sendRetain: () => {
				pi.sendMessage(
					{
						customType: RETAIN_REQUEST_CUSTOM_TYPE,
						content: RETAIN_REQUEST,
						display: false,
						details: { synthetic: true },
					},
					{ triggerTurn: true },
				);
			},
			setRenderingActive: setRetainRenderingActive,
			onRetained: ({ count }) => {
				if (count === 1 || !activeNoticePeriodId) activeNoticePeriodId = randomUUID();
				recordRetainNoticeCount(activeNoticePeriodId, count);
				if (count === 1) {
					pi.appendEntry<RetainNoticeData>(RETAIN_NOTICE_ENTRY_TYPE, {
						periodId: activeNoticePeriodId,
						count,
					});
				} else {
					pi.appendEntry<RetainNoticeUpdateData>(RETAIN_NOTICE_UPDATE_ENTRY_TYPE, {
						periodId: activeNoticePeriodId,
						count,
					});
				}
			},
			onFailure: (message) => {
				latestContext?.ui.notify(`pi-cache-retain: ${message}`, "error");
			},
		});
	}

	function noteHumanActivity(ctx: ExtensionContext): void {
		rememberContext(ctx);
		controller?.noteHumanActivity();
	}

	function applySetting(id: SettingId, value: string, ctx: ExtensionContext): boolean {
		if (!config || !controller) return false;
		const next = cloneConfig(config);
		if (id.kind === "showNotification") {
			next.showNotification = value === "on";
		} else {
			const key = id.kind === "interval" ? "intervalMs" : "maxIdleMs";
			const timing = { ...next.providerOverrides[id.provider] };
			if (value === AUTO_VALUE) {
				delete timing[key];
			} else {
				timing[key] = Number.parseInt(value, 10) * 60_000;
			}
			if (timing.intervalMs === undefined && timing.maxIdleMs === undefined) {
				delete next.providerOverrides[id.provider];
			} else {
				next.providerOverrides[id.provider] = timing;
			}
		}

		try {
			saveConfig(next);
		} catch (error) {
			ctx.ui.notify(
				`pi-cache-retain: Failed to save config.json: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}

		config = next;
		if (id.kind === "showNotification") {
			setRetainNotificationVisible(next.showNotification);
		} else {
			activeNoticePeriodId = undefined;
			controller.updateConfig(next);
		}
		return true;
	}

	async function openSettings(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui" || !config || !controller) {
			ctx.ui.notify("pi-cache-retain: Settings require TUI mode.", "error");
			return;
		}

		const intervalValues = [AUTO_VALUE, ...INTERVAL_MINUTE_OPTIONS.map(minuteLabel)];
		const maxIdleValues = [AUTO_VALUE, ...MAX_IDLE_MINUTE_OPTIONS.map(minuteLabel)];
		const rows: SettingRow[] = [
			{
				id: { kind: "showNotification" },
				label: "Show notification",
				values: ["on", "off"],
				valueIndex: config.showNotification ? 0 : 1,
			},
		];
		for (const provider of config.providers) {
			const override = config.providerOverrides[provider];
			rows.push({
				id: { kind: "interval", provider },
				label: `${provider} interval`,
				values: intervalValues,
				valueIndex: Math.max(0, intervalValues.indexOf(timingValueLabel(override?.intervalMs))),
			});
			rows.push({
				id: { kind: "maxIdle", provider },
				label: `${provider} max idle`,
				values: maxIdleValues,
				valueIndex: Math.max(0, maxIdleValues.indexOf(timingValueLabel(override?.maxIdleMs))),
			});
		}

		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			let selectedIndex = 0;
			const settingsTheme = getSettingsListTheme();

			return {
				render(width: number): string[] {
					const lines = [theme.fg("accent", theme.bold("Cache Retain Settings")), ""];
					for (let index = 0; index < rows.length; index++) {
						const row = rows[index];
						const selected = index === selectedIndex;
						const cursor = selected ? settingsTheme.cursor : " ";
						const label = settingsTheme.label(row.label.padEnd(24), selected);
						const value = settingsTheme.value(row.values[row.valueIndex] ?? "", selected);
						lines.push(truncateToWidth(`${cursor} ${label}${value}`, width, ""));
					}
					lines.push("", settingsTheme.hint("  ↑↓ select · ←→ change · Esc close"));
					return lines.map((line) => truncateToWidth(line, width, ""));
				},
				invalidate(): void {},
				handleInput(data: string): void {
					if (keybindings.matches(data, "tui.select.up")) {
						selectedIndex = selectedIndex === 0 ? rows.length - 1 : selectedIndex - 1;
					} else if (keybindings.matches(data, "tui.select.down")) {
						selectedIndex = selectedIndex === rows.length - 1 ? 0 : selectedIndex + 1;
					} else if (matchesKey(data, "left") || matchesKey(data, "right")) {
						const row = rows[selectedIndex];
						const direction = matchesKey(data, "left") ? -1 : 1;
						const nextIndex = (row.valueIndex + direction + row.values.length) % row.values.length;
						const nextValue = row.values[nextIndex] ?? row.values[0];
						if (applySetting(row.id, nextValue, ctx)) {
							row.valueIndex = nextIndex;
							if (row.id.kind === "showNotification") tui.invalidate();
						}
					} else if (keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					}
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("cache-retain", {
		description: "Configure prompt cache retention",
		handler: async (_args, ctx) => {
			rememberContext(ctx);
			await openSettings(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		rememberContext(ctx);
		if (ctx.mode === "tui") installRetainRendererPatches();
		controller?.shutdown();
		activeNoticePeriodId = undefined;
		hydrateRetainNoticeState(ctx.sessionManager.getEntries());
		controller = createController(ctx);
		controller?.start(false);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "interactive") {
			rememberContext(ctx);
			controller?.noteConversationStarted();
		} else {
			rememberContext(ctx);
		}
	});

	pi.on("user_bash", async (_event, ctx) => {
		noteHumanActivity(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		rememberContext(ctx);
		activeNoticePeriodId = undefined;
		controller?.waitForNextConversation();
	});
	pi.on("session_before_compact", async (_event, ctx) => {
		noteHumanActivity(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		noteHumanActivity(ctx);
	});
	pi.on("session_info_changed", async (_event, ctx) => {
		noteHumanActivity(ctx);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		noteHumanActivity(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") {
			rememberContext(ctx);
			controller?.noteRuntimeChanged();
		} else {
			noteHumanActivity(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		rememberContext(ctx);
		if (!controller?.isRetainInFlight() || event.message.role !== "assistant") return;
		controller.noteAssistantOutcome(classifyRetainResponse(event.message));
	});

	pi.on("tool_call", async (_event, ctx) => {
		rememberContext(ctx);
		if (!controller?.shouldGuardRetainTurn()) return;
		controller.noteToolCall();
		return {
			block: true,
			reason: "Cache retain control messages must not call tools.",
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		rememberContext(ctx);
		controller?.noteAgentSettled();
	});

	pi.on("session_shutdown", async () => {
		controller?.shutdown();
		controller = undefined;
		config = undefined;
		latestContext = undefined;
		activeNoticePeriodId = undefined;
		setRetainRenderingActive(false);
		setRetainNotificationVisible(false);
		clearRetainNoticeState();
		uninstallRetainRendererPatches();
	});
}
