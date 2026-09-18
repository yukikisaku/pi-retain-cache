import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./load-ts.mjs";

const { RetainController } = await loadTs("../retain-controller.ts");

const INTERVAL = 4 * 60_000;
const MAX_IDLE = 30 * 60_000;
const REQUEST_TIMEOUT = 2 * 60_000;

class FakeScheduler {
	time = 0;
	nextId = 1;
	timers = new Map();

	now = () => this.time;
	setTimer = (callback, delayMs) => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.time + delayMs, callback });
		return id;
	};
	clearTimer = (id) => {
		this.timers.delete(id);
	};

	advance(ms) {
		const target = this.time + ms;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [id, timer] = due;
			this.timers.delete(id);
			this.time = timer.at;
			timer.callback();
		}
		this.time = target;
	}
}

function setup(overrides = {}, actionOverrides = {}) {
	const scheduler = new FakeScheduler();
	const state = {
		runtime: { isIdle: true, hasPendingMessages: false, provider: "openai-codex" },
		sends: 0,
		rendering: false,
		notices: [],
		failures: [],
	};
	const config = {
		enabled: true,
		intervalMs: INTERVAL,
		maxIdleMs: MAX_IDLE,
		requestTimeoutMs: REQUEST_TIMEOUT,
		providers: ["openai-codex", "claude-bridge"],
		providerOverrides: {},
		showNotification: true,
		...overrides,
	};
	const controller = new RetainController(config, {
		getRuntime: () => state.runtime,
		sendRetain: () => { state.sends++; },
		setRenderingActive: (active) => { state.rendering = active; },
		onRetained: (notice) => { state.notices.push(notice); },
		onFailure: (message) => { state.failures.push(message); },
		...actionOverrides,
	}, scheduler);
	return { controller, scheduler, state };
}

function completeRetain(controller) {
	controller.noteAssistantOutcome("retained");
	controller.noteAgentSettled();
}

test("4分ごとに維持し、成功するたびに回数を通知する", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);

	scheduler.advance(INTERVAL - 1);
	assert.equal(state.sends, 0);
	scheduler.advance(1);
	assert.equal(state.sends, 1);
	assert.equal(state.rendering, true);
	completeRetain(controller);
	assert.equal(state.rendering, false);
	assert.equal(state.notices.length, 1);
	assert.equal(state.notices[0].count, 1);

	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 2);
	completeRetain(controller);
	assert.equal(state.notices.length, 2);
	assert.equal(state.notices[1].count, 2);
	assert.equal(controller.getStatus().retainedCount, 2);
});

test("30分の上限を越える維持リクエストを送らない", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);

	for (let count = 0; count < 7; count++) {
		scheduler.advance(INTERVAL);
		assert.equal(state.sends, count + 1);
		completeRetain(controller);
	}

	assert.equal(controller.getStatus().nextRunInMs, undefined);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 7);
});

test("ユーザー操作で放置期間と通知状態をリセットする", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	completeRetain(controller);
	assert.equal(state.notices.length, 1);

	controller.noteHumanActivity();
	assert.equal(controller.getStatus().retainedCount, 0);
	scheduler.advance(INTERVAL);
	completeRetain(controller);
	assert.equal(state.notices.length, 2);
});

test("想定外の返答後は次の通常会話終了まで停止する", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	controller.noteAssistantOutcome("unexpected");
	controller.noteAgentSettled();

	assert.equal(state.failures.length, 1);
	assert.equal(controller.getStatus().blocked, true);
	scheduler.advance(INTERVAL * 2);
	assert.equal(state.sends, 1);

	controller.noteHumanActivity();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, true);

	controller.noteConversationStarted();
	controller.noteAgentSettled();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 2);
});

test("プロバイダー別のoverrideがあればその間隔でスケジュールする", () => {
	const { controller, scheduler, state } = setup({
		providerOverrides: { "openai-codex": { intervalMs: 10 * 60_000, maxIdleMs: 60 * 60_000 } },
	});
	controller.start(true);

	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);
	scheduler.advance(10 * 60_000 - INTERVAL);
	assert.equal(state.sends, 1);
});

test("resolveTimingがあれば現在のプロバイダーの間隔を使う", () => {
	const timings = {
		"claude-bridge": { intervalMs: 50 * 60_000, maxIdleMs: 120 * 60_000 },
		"openai-codex": { intervalMs: INTERVAL, maxIdleMs: MAX_IDLE },
	};
	const { controller, scheduler, state } = setup({}, {
		resolveTiming: (provider) => timings[provider] ?? { intervalMs: INTERVAL, maxIdleMs: MAX_IDLE },
	});
	state.runtime.provider = "claude-bridge";
	controller.start(true);

	assert.equal(controller.getStatus().nextRunInMs, 50 * 60_000);
	scheduler.advance(50 * 60_000);
	assert.equal(state.sends, 1);
	completeRetain(controller);

	// モデル切替(claude→codex)後の再スケジュールで短い間隔に切り替わる。
	// ただしidle残り時間の上限(codexはmaxIdle 30分)を超えているのでここでは止まる。
	state.runtime.provider = "openai-codex";
	controller.noteRuntimeChanged();
	assert.equal(controller.getStatus().nextRunInMs, undefined);

	// ユーザー操作でidle期間がリセットされればcodexの4分間隔で動く
	controller.noteHumanActivity();
	assert.equal(controller.getStatus().nextRunInMs, INTERVAL);
});

test("対象外プロバイダには送らない", () => {
	const { controller, scheduler, state } = setup();
	state.runtime.provider = "google";
	controller.start(true);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);
});

test("実行予定時に操作中なら次の間隔で再確認する", () => {
	const { controller, scheduler, state } = setup();
	state.runtime.isIdle = false;
	controller.start(true);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);
	assert.equal(controller.getStatus().nextRunInMs, INTERVAL);

	state.runtime.isIdle = true;
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);
});

test("通常の会話履歴がない空セッションでは開始しない", () => {
	const { controller, scheduler, state } = setup();
	controller.start(false);
	scheduler.advance(INTERVAL * 2);
	assert.equal(state.sends, 0);

	controller.noteAgentSettled();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);
});

test("空セッションでは設定をonにしても開始しない", () => {
	const { controller, scheduler, state } = setup({ enabled: false });
	controller.start(false);
	controller.setEnabled(true);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);
});

test("会話履歴があるセッションでは設定をonにすると再開する", () => {
	const { controller, scheduler, state } = setup({ enabled: false });
	controller.start(true);
	controller.setEnabled(true);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);
});

test("維持中でもユーザー操作後の通常ツールは遮断しない", () => {
	const { controller, scheduler } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	assert.equal(controller.shouldGuardRetainTurn(), true);

	controller.noteHumanActivity();
	assert.equal(controller.shouldGuardRetainTurn(), false);
});

test("再開直後のユーザー操作だけでは開始しない", () => {
	const { controller, scheduler, state } = setup();
	controller.start(false);
	controller.noteHumanActivity();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);
});

test("tree移動後は次の通常会話終了まで開始しない", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	controller.waitForNextConversation();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 0);

	controller.noteAgentSettled();
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);
});

test("設定変更時点から新しい間隔で数え直す", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(3 * 60_000);
	controller.updateConfig({
		enabled: true,
		intervalMs: 2 * 60_000,
		maxIdleMs: MAX_IDLE,
		requestTimeoutMs: REQUEST_TIMEOUT,
		providers: ["openai-codex", "claude-bridge"],
		showNotification: true,
	});
	assert.equal(controller.getStatus().nextRunInMs, 2 * 60_000);
	scheduler.advance(2 * 60_000);
	assert.equal(state.sends, 1);
});

test("実行中に無効化した場合は完了結果を数えない", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	controller.setEnabled(false);
	completeRetain(controller);
	assert.equal(state.notices.length, 0);
	assert.equal(controller.getStatus().nextRunInMs, undefined);
});

test("応答が来ない場合は監視タイマーで停止する", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	assert.equal(state.sends, 1);

	scheduler.advance(REQUEST_TIMEOUT);
	assert.equal(controller.getStatus().blocked, true);
	assert.equal(state.rendering, false);
	assert.equal(state.failures.length, 1);
	assert.equal(controller.shouldGuardRetainTurn(), true);

	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, true);
	assert.equal(controller.getStatus().nextRunInMs, undefined);
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, true);

	controller.noteConversationStarted();
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, false);
	assert.equal(controller.getStatus().nextRunInMs, INTERVAL);
});

test("維持リクエストの中断後は次の通常会話終了まで停止する", () => {
	const { controller, scheduler, state } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	controller.noteAssistantOutcome("error");
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, true);
	assert.equal(state.failures.length, 1);
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, true);

	controller.noteConversationStarted();
	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, false);
	assert.equal(controller.getStatus().nextRunInMs, INTERVAL);
});

test("タイムアウト中に通常会話が続いた場合は同じsettledで再開する", () => {
	const { controller, scheduler } = setup();
	controller.start(true);
	scheduler.advance(INTERVAL);
	controller.noteConversationStarted();
	scheduler.advance(REQUEST_TIMEOUT);
	assert.equal(controller.getStatus().blocked, true);
	assert.equal(controller.shouldGuardRetainTurn(), false);

	controller.noteAgentSettled();
	assert.equal(controller.getStatus().blocked, false);
	assert.equal(controller.getStatus().nextRunInMs, INTERVAL);
});
