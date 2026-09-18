import { resolveProviderTiming, type CacheRetainConfig, type ResolvedTiming } from "./config.js";
import type { RetainResponseOutcome } from "./retain-protocol.js";

export type RetainRuntimeSnapshot = {
	isIdle: boolean;
	hasPendingMessages: boolean;
	provider?: string;
};

export type RetainNotice = {
	count: number;
	retainedAt: number;
};

export type RetainControllerActions = {
	getRuntime(): RetainRuntimeSnapshot;
	/** プロバイダー別の実効タイミング。省略時はconfigの既定値を使う。 */
	resolveTiming?(provider: string | undefined): ResolvedTiming;
	sendRetain(): void;
	setRenderingActive(active: boolean): void;
	onRetained(notice: RetainNotice): void;
	onFailure(message: string): void;
};

export type RetainScheduler = {
	now(): number;
	setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

export type RetainControllerStatus = {
	enabled: boolean;
	blocked: boolean;
	inFlight: boolean;
	retainedCount: number;
	idleMs: number;
	nextRunInMs?: number;
};

const systemScheduler: RetainScheduler = {
	now: () => Date.now(),
	setTimer(callback, delayMs) {
		const timer = setTimeout(callback, delayMs);
		timer.unref?.();
		return timer;
	},
	clearTimer: (timer) => clearTimeout(timer),
};

export class RetainController {
	private providers: Set<string>;
	private enabled: boolean;
	private blocked = false;
	private started = false;
	private armed = false;
	private inFlight = false;
	private responseSeen = false;
	private responseFailure: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	private nextRunAt: number | undefined;
	private idleSince = 0;
	private retainedCount = 0;
	private activityGeneration = 0;
	private retainGeneration = 0;
	// タイムアウトは応答待ちを打ち切るだけで、元のエージェントターンは終了させない。
	// 遅れた応答は正しいタグとは限らず、本文なしのエラーやツール呼び出しもあり得るため、
	// 応答本文ではなくagent_settledが届くまで元の維持ターンを追跡する。
	private retainTurnAwaitingSettlement = false;
	private conversationStartedAfterRetain = false;

	constructor(
		private config: CacheRetainConfig,
		private readonly actions: RetainControllerActions,
		private readonly scheduler: RetainScheduler = systemScheduler,
	) {
		this.enabled = config.enabled;
		this.providers = new Set(config.providers);
	}

	start(armed = false): void {
		if (this.started) return;
		this.started = true;
		this.idleSince = this.scheduler.now();
		this.armed = armed;
		if (armed) this.scheduleNextRun();
	}

	shutdown(): void {
		this.started = false;
		this.clearScheduledRun();
		this.clearWatchdog();
		this.inFlight = false;
		this.retainTurnAwaitingSettlement = false;
		this.conversationStartedAfterRetain = false;
		this.actions.setRenderingActive(false);
	}

	updateConfig(config: CacheRetainConfig): void {
		this.config = config;
		this.enabled = config.enabled;
		this.providers = new Set(config.providers);
		this.clearScheduledRun();
		if (!this.enabled) {
			if (!this.inFlight) this.actions.setRenderingActive(false);
			return;
		}
		if (this.armed && !this.blocked && !this.inFlight) this.beginIdlePeriod();
	}

	setEnabled(enabled: boolean): void {
		this.updateConfig({ ...this.config, enabled });
	}

	noteHumanActivity(): void {
		this.activityGeneration++;
		if (!this.armed && !this.inFlight) return;
		this.beginIdlePeriod();
	}

	noteConversationStarted(): void {
		if (this.blocked || this.inFlight || this.retainTurnAwaitingSettlement) {
			this.conversationStartedAfterRetain = true;
		}
		this.noteHumanActivity();
	}

	waitForNextConversation(): void {
		this.activityGeneration++;
		this.armed = false;
		this.retainedCount = 0;
		this.conversationStartedAfterRetain = false;
		this.clearScheduledRun();
		if (!this.inFlight) this.actions.setRenderingActive(false);
	}

	noteRuntimeChanged(): void {
		if (!this.started || !this.enabled || !this.armed || this.blocked || this.inFlight) return;
		this.clearScheduledRun();
		this.scheduleNextRun();
	}

	noteAssistantOutcome(outcome: RetainResponseOutcome): void {
		if (!this.inFlight) return;
		if (outcome === "retained") {
			this.responseSeen = true;
			return;
		}
		if (outcome === "unexpected") {
			this.responseFailure = "The model returned an unexpected response.";
		}
		if (outcome === "error") {
			this.responseFailure = "The cache retention request failed.";
		}
	}

	noteToolCall(): void {
		if (!this.shouldGuardRetainTurn()) return;
		this.responseFailure = "The model attempted to call a tool during cache retention.";
	}

	noteAgentSettled(): void {
		if (!this.started) return;

		if (this.retainTurnAwaitingSettlement) {
			this.retainTurnAwaitingSettlement = false;
			const conversationCompleted = this.conversationStartedAfterRetain;
			this.conversationStartedAfterRetain = false;
			if (conversationCompleted) {
				this.blocked = false;
				this.beginIdlePeriod();
			}
			return;
		}

		if (!this.inFlight) {
			if (this.blocked && !this.conversationStartedAfterRetain) return;
			this.conversationStartedAfterRetain = false;
			this.blocked = false;
			this.beginIdlePeriod();
			return;
		}

		this.clearWatchdog();
		const supersededByHumanActivity = this.retainGeneration !== this.activityGeneration;
		const failure = this.responseFailure;
		const retained = this.responseSeen && !failure;

		this.inFlight = false;
		this.responseSeen = false;
		this.responseFailure = undefined;
		this.actions.setRenderingActive(false);

		if (supersededByHumanActivity) {
			this.conversationStartedAfterRetain = false;
			if (this.armed) this.beginIdlePeriod();
			return;
		}

		if (!this.enabled) return;
		if (!retained) {
			this.blocked = true;
			this.clearScheduledRun();
			this.actions.onFailure(failure ?? "No cache retention response was received.");
			return;
		}

		this.retainedCount++;
		this.actions.onRetained({
			count: this.retainedCount,
			retainedAt: this.scheduler.now(),
		});
		this.scheduleNextRun();
	}

	isRetainInFlight(): boolean {
		return this.inFlight;
	}

	shouldGuardRetainTurn(): boolean {
		return (this.inFlight || this.retainTurnAwaitingSettlement)
			&& this.retainGeneration === this.activityGeneration;
	}

	getStatus(): RetainControllerStatus {
		const now = this.scheduler.now();
		return {
			enabled: this.enabled,
			blocked: this.blocked,
			inFlight: this.inFlight,
			retainedCount: this.retainedCount,
			idleMs: this.armed ? Math.max(0, now - this.idleSince) : 0,
			nextRunInMs: this.nextRunAt === undefined ? undefined : Math.max(0, this.nextRunAt - now),
		};
	}

	private beginIdlePeriod(): void {
		this.idleSince = this.scheduler.now();
		this.armed = true;
		this.retainedCount = 0;
		this.clearScheduledRun();
		if (this.started && this.enabled && !this.blocked && !this.inFlight) {
			this.scheduleNextRun();
		}
	}

	private currentTiming(): ResolvedTiming {
		const provider = this.actions.getRuntime().provider;
		if (this.actions.resolveTiming) return this.actions.resolveTiming(provider);
		return resolveProviderTiming(this.config, provider);
	}

	private scheduleNextRun(): void {
		this.clearScheduledRun();
		if (!this.started || !this.enabled || !this.armed || this.blocked || this.inFlight) return;

		const timing = this.currentTiming();
		const now = this.scheduler.now();
		const idleRemainingMs = timing.maxIdleMs - (now - this.idleSince);
		if (idleRemainingMs < timing.intervalMs) return;

		this.nextRunAt = now + timing.intervalMs;
		this.timer = this.scheduler.setTimer(() => {
			this.timer = undefined;
			this.nextRunAt = undefined;
			this.runRetain();
		}, timing.intervalMs);
	}

	private runRetain(): void {
		if (!this.started || !this.enabled || !this.armed || this.blocked || this.inFlight) return;
		if (this.scheduler.now() - this.idleSince >= this.currentTiming().maxIdleMs) return;

		const runtime = this.actions.getRuntime();
		if (!runtime.provider || !this.providers.has(runtime.provider)) return;
		if (!runtime.isIdle || runtime.hasPendingMessages) {
			this.scheduleNextRun();
			return;
		}

		this.inFlight = true;
		this.retainTurnAwaitingSettlement = false;
		this.conversationStartedAfterRetain = false;
		this.responseSeen = false;
		this.responseFailure = undefined;
		this.retainGeneration = this.activityGeneration;
		this.actions.setRenderingActive(true);
		this.startWatchdog();

		try {
			this.actions.sendRetain();
		} catch (error) {
			this.clearWatchdog();
			this.inFlight = false;
			this.actions.setRenderingActive(false);
			this.blocked = true;
			this.actions.onFailure(
				`Failed to start the cache retention request: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private startWatchdog(): void {
		this.clearWatchdog();
		this.watchdogTimer = this.scheduler.setTimer(() => {
			this.watchdogTimer = undefined;
			if (!this.inFlight) return;

			this.inFlight = false;
			this.retainTurnAwaitingSettlement = true;
			this.responseSeen = false;
			this.responseFailure = undefined;
			this.actions.setRenderingActive(false);

			this.blocked = true;
			this.actions.onFailure("The cache retention request timed out.");
		}, this.config.requestTimeoutMs);
	}

	private clearWatchdog(): void {
		if (this.watchdogTimer === undefined) return;
		this.scheduler.clearTimer(this.watchdogTimer);
		this.watchdogTimer = undefined;
	}

	private clearScheduledRun(): void {
		if (this.timer !== undefined) {
			this.scheduler.clearTimer(this.timer);
			this.timer = undefined;
		}
		this.nextRunAt = undefined;
	}
}
