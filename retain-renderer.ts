import {
	AssistantMessageComponent,
	TreeSelectorComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

import {
	RETAIN_NOTICE_ENTRY_TYPE,
	RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
	type AssistantMessageLike,
	type RetainNoticeData,
	type RetainNoticeUpdateData,
} from "./retain-protocol.js";
import {
	applyRetainNoticeEntry,
	buildRetainNoticeCounts,
	getRetainNoticeDisplay,
	type RetainNoticeEntryLike,
} from "./retain-notice-logic.js";
import {
	isHiddenRetainTreeEntry,
	shouldHideAssistantMessage,
	type TreeEntryLike,
} from "./retain-renderer-logic.js";

const ASSISTANT_PATCHED = Symbol.for("pi-cache-retain.assistant-renderer-patched");
const ASSISTANT_ORIGINAL = Symbol.for("pi-cache-retain.assistant-renderer-original");
const TREE_PATCHED = Symbol.for("pi-cache-retain.tree-renderer-patched");
const TREE_ORIGINAL = Symbol.for("pi-cache-retain.tree-renderer-original");
const TREE_LIST_PATCHED = Symbol.for("pi-cache-retain.tree-list-patched");
const RENDER_STATE = Symbol.for("pi-cache-retain.render-state");

type RenderState = {
	active: boolean;
	showNotification: boolean;
	noticeCounts: Map<string, number>;
};

type LegacyRetainNoticeData = {
	retainedAt?: number;
};

type NoticeTheme = {
	fg(color: "accent" | "muted", text: string): string;
};

type AssistantPrototype = {
	updateContent(message: AssistantMessageLike): void;
} & Record<PropertyKey, unknown>;

type AssistantInstance = {
	lastMessage?: AssistantMessageLike;
	contentContainer: { clear(): void };
	hasToolCalls: boolean;
};

type FlatTreeNodeLike = {
	node: {
		entry: TreeEntryLike;
	};
};

type TreeListLike = {
	applyFilter(): void;
	findNearestVisibleIndex(entryId: string | null): number;
	recalculateVisualStructure(): void;
	flatNodes: FlatTreeNodeLike[];
	filteredNodes: FlatTreeNodeLike[];
	selectedIndex: number;
	lastSelectedId: string | null;
	currentLeafId: string | null;
} & Record<PropertyKey, unknown>;

type TreeSelectorPrototype = {
	render(width: number): string[];
	getTreeList(): TreeListLike;
} & Record<PropertyKey, unknown>;

class RetainNoticeComponent implements Component {
	constructor(
		private readonly periodId: string,
		private readonly fallbackCount: number,
		private readonly theme: NoticeTheme,
	) {}

	render(width: number): string[] {
		const state = getRenderState();
		if (!state.showNotification) return [];
		const count = state.noticeCounts.get(this.periodId) ?? this.fallbackCount;
		return new Text(
			`${this.theme.fg("accent", "↻")}  ${this.theme.fg("muted", `cache retained ×${count}`)}`,
			1,
			0,
		).render(width);
	}

	invalidate(): void {}
}

function getRenderState(): RenderState {
	const host = globalThis as Record<PropertyKey, unknown>;
	const existing = host[RENDER_STATE] as Partial<RenderState> | undefined;
	if (existing) {
		existing.active ??= false;
		existing.showNotification ??= true;
		existing.noticeCounts ??= new Map<string, number>();
		return existing as RenderState;
	}
	const state: RenderState = {
		active: false,
		showNotification: true,
		noticeCounts: new Map(),
	};
	host[RENDER_STATE] = state;
	return state;
}

export function setRetainRenderingActive(active: boolean): void {
	getRenderState().active = active;
}

export function setRetainNotificationVisible(visible: boolean): void {
	getRenderState().showNotification = visible;
}

export function recordRetainNoticeCount(periodId: string, count: number): void {
	getRenderState().noticeCounts.set(periodId, count);
}

export function hydrateRetainNoticeState(entries: readonly RetainNoticeEntryLike[]): void {
	getRenderState().noticeCounts = buildRetainNoticeCounts(entries);
}

export function clearRetainNoticeState(): void {
	getRenderState().noticeCounts.clear();
}

function installAssistantRendererPatch(): void {
	const prototype = AssistantMessageComponent.prototype as unknown as AssistantPrototype;
	if (prototype[ASSISTANT_PATCHED]) return;

	const originalUpdateContent = prototype.updateContent;
	prototype[ASSISTANT_ORIGINAL] = originalUpdateContent;
	prototype.updateContent = function patchedUpdateContent(
		this: AssistantInstance,
		message: AssistantMessageLike,
	): void {
		if (!shouldHideAssistantMessage(message, getRenderState().active)) {
			originalUpdateContent.call(this, message);
			return;
		}

		this.lastMessage = message;
		this.contentContainer.clear();
		this.hasToolCalls = false;
	};
	prototype[ASSISTANT_PATCHED] = true;
}

function patchTreeList(treeList: TreeListLike): void {
	if (treeList[TREE_LIST_PATCHED]) return;

	const originalApplyFilter = treeList.applyFilter;
	treeList.applyFilter = function patchedApplyFilter(this: TreeListLike): void {
		originalApplyFilter.call(this);
		const entryById = new Map(
			this.flatNodes
				.map((flatNode) => flatNode.node.entry)
				.filter((entry): entry is TreeEntryLike & { id: string } => typeof entry.id === "string")
				.map((entry) => [entry.id, entry]),
		);
		this.filteredNodes = this.filteredNodes.filter(
			(flatNode) => !isHiddenRetainTreeEntry(flatNode.node.entry, entryById),
		);
		this.recalculateVisualStructure();

		const targetId = this.lastSelectedId ?? this.currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	};
	treeList[TREE_LIST_PATCHED] = true;
	treeList.applyFilter();
}

function installTreeRendererPatch(): void {
	const prototype = TreeSelectorComponent.prototype as unknown as TreeSelectorPrototype;
	if (prototype[TREE_PATCHED]) return;

	const originalRender = prototype.render;
	prototype[TREE_ORIGINAL] = originalRender;
	prototype.render = function patchedRender(this: TreeSelectorPrototype, width: number): string[] {
		patchTreeList(this.getTreeList());
		return originalRender.call(this, width);
	};
	prototype[TREE_PATCHED] = true;
}

export function installRetainRendererPatches(): void {
	installAssistantRendererPatch();
	installTreeRendererPatch();
}

export function uninstallRetainRendererPatches(): void {
	const assistantPrototype = AssistantMessageComponent.prototype as unknown as AssistantPrototype;
	const assistantOriginal = assistantPrototype[ASSISTANT_ORIGINAL] as AssistantPrototype["updateContent"] | undefined;
	if (assistantPrototype[ASSISTANT_PATCHED] && assistantOriginal) {
		assistantPrototype.updateContent = assistantOriginal;
		delete assistantPrototype[ASSISTANT_ORIGINAL];
		assistantPrototype[ASSISTANT_PATCHED] = false;
	}

	const treePrototype = TreeSelectorComponent.prototype as unknown as TreeSelectorPrototype;
	const treeOriginal = treePrototype[TREE_ORIGINAL] as TreeSelectorPrototype["render"] | undefined;
	if (treePrototype[TREE_PATCHED] && treeOriginal) {
		treePrototype.render = treeOriginal;
		delete treePrototype[TREE_ORIGINAL];
		treePrototype[TREE_PATCHED] = false;
	}
}

export function registerRetainNoticeRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<RetainNoticeData | LegacyRetainNoticeData>(
		RETAIN_NOTICE_ENTRY_TYPE,
		(entry, _options, theme): Component | undefined => {
			const state = getRenderState();
			const display = getRetainNoticeDisplay(entry, state.noticeCounts, true);
			if (!display) return undefined;
			const current = state.noticeCounts.get(display.periodId);
			if (current === undefined) recordRetainNoticeCount(display.periodId, display.count);
			return new RetainNoticeComponent(display.periodId, display.count, theme);
		},
	);
	pi.registerEntryRenderer<RetainNoticeUpdateData>(
		RETAIN_NOTICE_UPDATE_ENTRY_TYPE,
		(entry): undefined => {
			applyRetainNoticeEntry(getRenderState().noticeCounts, entry);
			return undefined;
		},
	);
}
