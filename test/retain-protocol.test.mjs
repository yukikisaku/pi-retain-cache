import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./load-ts.mjs";

const {
	classifyRetainResponse,
	isExactRetainResponse,
	isRetainResponsePrefix,
	RETAIN_RESPONSE,
} = await loadTs("../retain-protocol.ts");

function assistant(text, overrides = {}) {
	return {
		role: "assistant",
		content: text === undefined ? [] : [{ type: "text", text }],
		stopReason: "stop",
		...overrides,
	};
}

test("正確なcache retainedタグだけを成功として扱う", () => {
	const message = assistant(RETAIN_RESPONSE);
	assert.equal(classifyRetainResponse(message), "retained");
	assert.equal(isExactRetainResponse(message), true);
});

test("タグのストリーミング途中を表示保留対象として扱う", () => {
	assert.equal(isRetainResponsePrefix(assistant("<cache-ret")), true);
	assert.equal(isRetainResponsePrefix(assistant("別の返答")), false);
});

test("追加説明とツール呼び出しを拒否する", () => {
	assert.equal(classifyRetainResponse(assistant(`${RETAIN_RESPONSE} done`)), "unexpected");
	assert.equal(classifyRetainResponse(assistant(RETAIN_RESPONSE, {
		content: [
			{ type: "text", text: RETAIN_RESPONSE },
			{ type: "toolCall" },
		],
	})), "unexpected");
});

test("エラー応答を失敗として扱う", () => {
	assert.equal(classifyRetainResponse(assistant(undefined, { stopReason: "error" })), "error");
});
