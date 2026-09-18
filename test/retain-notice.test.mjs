import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./load-ts.mjs";

const {
	applyRetainNoticeEntry,
	buildRetainNoticeCounts,
	getRetainNoticeDisplay,
	getRetainNoticeIdentity,
} = await loadTs("../retain-notice-logic.ts");
const {
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
} = await loadTs("../retain-protocol.ts");

test("同じ放置期間の更新から最終回数を復元する", () => {
	const counts = buildRetainNoticeCounts([
		{
			id: "notice-1",
			customType: RETAIN_NOTICE_ENTRY_TYPE,
			data: { periodId: "period-1", count: 1 },
		},
		{
			id: "update-1",
			customType: RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
			data: { periodId: "period-1", count: 2 },
		},
		{
			id: "update-2",
			customType: RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
			data: { periodId: "period-1", count: 3 },
		},
	]);
	assert.equal(counts.get("period-1"), 3);
	assert.equal(counts.size, 1);
});

test("放置期間が変わると別の回数として保持する", () => {
	const counts = new Map();
	applyRetainNoticeEntry(counts, {
		id: "notice-a",
		customType: RETAIN_NOTICE_ENTRY_TYPE,
		data: { periodId: "period-a", count: 2 },
	});
	applyRetainNoticeEntry(counts, {
		id: "notice-b",
		customType: RETAIN_NOTICE_ENTRY_TYPE,
		data: { periodId: "period-b", count: 1 },
	});
	assert.deepEqual([...counts.entries()], [["period-a", 2], ["period-b", 1]]);
});

test("旧形式の通知はentry idを期間IDとして1回に復元する", () => {
	assert.deepEqual(
		getRetainNoticeIdentity({
			id: "legacy-notice",
			customType: RETAIN_NOTICE_ENTRY_TYPE,
			data: { retainedAt: 123 },
		}),
		{ periodId: "legacy-notice", count: 1 },
	);
});

test("通知offでは過去の通知も描画対象にしない", () => {
	const entry = {
		id: "notice-1",
		customType: RETAIN_NOTICE_ENTRY_TYPE,
		data: { periodId: "period-1", count: 1 },
	};
	assert.equal(getRetainNoticeDisplay(entry, new Map([["period-1", 3]]), false), undefined);
	assert.deepEqual(
		getRetainNoticeDisplay(entry, new Map([["period-1", 3]]), true),
		{ periodId: "period-1", count: 3 },
	);
});

test("更新entry自体は描画対象にしない", () => {
	assert.equal(getRetainNoticeDisplay({
		id: "update-1",
		customType: RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
		data: { periodId: "period-1", count: 2 },
	}, new Map(), true), undefined);
});

test("不正な更新回数は無視する", () => {
	const counts = new Map([["period-1", 2]]);
	applyRetainNoticeEntry(counts, {
		customType: RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
		data: { periodId: "period-1", count: 0 },
	});
	assert.equal(counts.get("period-1"), 2);
});
