export const RETAIN_REQUEST = "<cache-retain/>";
export const RETAIN_RESPONSE = "<cache-retained/>";
export const RETAIN_REQUEST_CUSTOM_TYPE = "pi-cache-retain-request";
export const RETAIN_NOTICE_ENTRY_TYPE = "pi-cache-retain-notice";
export const RETAIN_NOTICE_UPDATE_ENTRY_TYPE = "pi-cache-retain-notice-update";

export type RetainNoticeData = {
	periodId: string;
	count: number;
};

export type RetainNoticeUpdateData = {
	periodId: string;
	count: number;
};

export type AssistantContentBlock = {
	type?: string;
	text?: string;
};

export type AssistantMessageLike = {
	role?: string;
	content?: AssistantContentBlock[];
	stopReason?: string;
	errorMessage?: string;
};

export type RetainResponseOutcome = "retained" | "pending" | "unexpected" | "error";

export function assistantText(message: AssistantMessageLike): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("")
		.trim();
}

export function hasToolCall(message: AssistantMessageLike): boolean {
	return Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall");
}

export function classifyRetainResponse(message: AssistantMessageLike): RetainResponseOutcome {
	if (message.role !== "assistant") return "pending";
	if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
		return "error";
	}
	if (hasToolCall(message)) return "unexpected";

	const text = assistantText(message);
	if (text === RETAIN_RESPONSE) return "retained";
	if (!text) return "pending";
	return "unexpected";
}

export function isRetainResponsePrefix(message: AssistantMessageLike): boolean {
	if (hasToolCall(message)) return false;
	const text = assistantText(message);
	return text.length === 0 || RETAIN_RESPONSE.startsWith(text);
}

export function isExactRetainResponse(message: AssistantMessageLike): boolean {
	return !hasToolCall(message) && assistantText(message) === RETAIN_RESPONSE;
}
