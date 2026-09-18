import {
	isExactRetainResponse,
	isRetainResponsePrefix,
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	RETAIN_REQUEST_CUSTOM_TYPE,
	type AssistantMessageLike,
} from "./retain-protocol.js";

export type TreeEntryLike = {
	type?: string;
	customType?: string;
	message?: AssistantMessageLike;
	id?: string;
	parentId?: string | null;
};

export function shouldHideAssistantMessage(message: AssistantMessageLike, active: boolean): boolean {
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
		return false;
	}
	if (isExactRetainResponse(message)) return true;
	return active && isRetainResponsePrefix(message);
}

export function isHiddenRetainTreeEntry(
	entry: TreeEntryLike,
	entryById?: ReadonlyMap<string, TreeEntryLike>,
): boolean {
	if (entry.type === "custom_message") {
		return entry.customType === RETAIN_REQUEST_CUSTOM_TYPE;
	}
	if (entry.type === "custom") {
		return entry.customType === RETAIN_NOTICE_ENTRY_TYPE || entry.customType === RETAIN_NOTICE_UPDATE_ENTRY_TYPE;
	}
	if (entry.type !== "message" || entry.message?.role !== "assistant" || !isExactRetainResponse(entry.message)) {
		return false;
	}
	if (!entryById) return true;

	const visited = new Set<string>();
	let parentId = entry.parentId;
	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = entryById.get(parentId);
		if (!parent) return false;
		if (parent.type === "custom_message") {
			return parent.customType === RETAIN_REQUEST_CUSTOM_TYPE;
		}
		if (parent.type === "message") return false;
		parentId = parent.parentId;
	}
	return false;
}
