import {
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	type RetainNoticeData,
	type RetainNoticeUpdateData,
} from "./retain-protocol.js";

export type RetainNoticeEntryLike = {
	id?: string;
	customType?: string;
	data?: unknown;
};

export type RetainNoticeIdentity = {
	periodId: string;
	count: number;
};

export type RetainNoticeDisplay = RetainNoticeIdentity;

function validCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function getRetainNoticeIdentity(entry: RetainNoticeEntryLike): RetainNoticeIdentity | undefined {
	if (entry.customType !== RETAIN_NOTICE_ENTRY_TYPE || !entry.id) return undefined;
	const data = entry.data as Partial<RetainNoticeData> | undefined;
	return {
		periodId: typeof data?.periodId === "string" && data.periodId ? data.periodId : entry.id,
		count: validCount(data?.count) ?? 1,
	};
}

export function getRetainNoticeDisplay(
	entry: RetainNoticeEntryLike,
	counts: ReadonlyMap<string, number>,
	visible: boolean,
): RetainNoticeDisplay | undefined {
	if (!visible) return undefined;
	const identity = getRetainNoticeIdentity(entry);
	if (!identity) return undefined;
	return {
		periodId: identity.periodId,
		count: counts.get(identity.periodId) ?? identity.count,
	};
}

export function applyRetainNoticeEntry(
	counts: Map<string, number>,
	entry: RetainNoticeEntryLike,
): void {
	const identity = getRetainNoticeIdentity(entry);
	if (identity) {
		counts.set(identity.periodId, identity.count);
		return;
	}
	if (entry.customType !== RETAIN_NOTICE_UPDATE_ENTRY_TYPE) return;
	const data = entry.data as Partial<RetainNoticeUpdateData> | undefined;
	const count = validCount(data?.count);
	if (typeof data?.periodId === "string" && data.periodId && count !== undefined) {
		counts.set(data.periodId, count);
	}
}

export function buildRetainNoticeCounts(entries: readonly RetainNoticeEntryLike[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) applyRetainNoticeEntry(counts, entry);
	return counts;
}
