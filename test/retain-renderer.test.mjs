import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./load-ts.mjs";

const {
	isHiddenRetainTreeEntry,
	shouldHideAssistantMessage,
} = await loadTs("../retain-renderer-logic.ts");
const {
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	RETAIN_REQUEST_CUSTOM_TYPE,
	RETAIN_RESPONSE,
} = await loadTs("../retain-protocol.ts");

function assistant(text, overrides = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		...overrides,
	};
}

test("cache retained応答を通常の会話表示から隠す", () => {
	assert.equal(shouldHideAssistantMessage(assistant(RETAIN_RESPONSE), false), true);
	assert.equal(shouldHideAssistantMessage(assistant("通常の返答"), false), false);
});

test("維持リクエスト中はタグのストリーミング途中も隠す", () => {
	assert.equal(shouldHideAssistantMessage(assistant("<cache-ret"), true), true);
	assert.equal(shouldHideAssistantMessage(assistant("通常の返答"), true), false);
});

test("エラーはタグに似ていても表示する", () => {
	assert.equal(shouldHideAssistantMessage(assistant("<cache-ret", { stopReason: "error" }), true), false);
});

test("treeから通知と更新用entryを隠す", () => {
	assert.equal(isHiddenRetainTreeEntry({
		type: "custom",
		customType: RETAIN_NOTICE_ENTRY_TYPE,
	}), true);
	assert.equal(isHiddenRetainTreeEntry({
		type: "custom",
		customType: RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	}), true);
});

test("treeから維持リクエストと、その応答だけを隠す", () => {
	const request = {
		type: "custom_message",
		id: "request",
		customType: RETAIN_REQUEST_CUSTOM_TYPE,
	};
	const metadata = {
		type: "custom",
		id: "metadata",
		parentId: "request",
	};
	const normalMessage = {
		type: "message",
		id: "normal-message",
		parentId: "request",
		message: assistant("通常の返答"),
	};
	const entries = new Map([
		["request", request],
		["metadata", metadata],
		["normal-message", normalMessage],
	]);
	assert.equal(isHiddenRetainTreeEntry(request, entries), true);
	assert.equal(isHiddenRetainTreeEntry({
		type: "message",
		parentId: "request",
		message: assistant(RETAIN_RESPONSE),
	}, entries), true);
	assert.equal(isHiddenRetainTreeEntry({
		type: "message",
		parentId: "metadata",
		message: assistant(RETAIN_RESPONSE),
	}, entries), true);
	assert.equal(isHiddenRetainTreeEntry({
		type: "message",
		parentId: "normal-message",
		message: assistant(RETAIN_RESPONSE),
	}, entries), false);
	assert.equal(isHiddenRetainTreeEntry({
		type: "message",
		parentId: "other",
		message: assistant(RETAIN_RESPONSE),
	}, entries), false);
	assert.equal(isHiddenRetainTreeEntry({
		type: "message",
		message: assistant("通常の返答"),
	}, entries), false);
});
