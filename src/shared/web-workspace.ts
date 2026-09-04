/**
 * Purpose: Transport-safe contracts for independent native OMP web chats.
 *
 * Public API: chat metadata, state, model, image, event, and `WebChats` service
 * types shared by the daemon integration and browser API boundary.
 *
 * Upstream deps: none. Native messages and events are projected into these
 * explicit browser-safe DTOs before crossing the API boundary.
 *
 * Downstream consumers: `src/daemon/web-chats.ts` and the web console API.
 *
 * Failure modes: declarations only. Callers must still validate untrusted HTTP
 * input before invoking the service; the service repeats its trust-boundary
 * validation for paths and model identifiers.
 *
 * Performance: type declarations only.
 */

export interface WebChatImage {
	type: "image";
	/** Base64-encoded image bytes. */
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
}

export interface WebChatModel {
	provider: string;
	id: string;
	contextWindow: number | null;
	reasoning: boolean;
	thinking?: {
		mode: string;
		efforts: readonly string[];
		defaultLevel?: string;
	};
}

export type WebChatTodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "abandoned"
	| "blocked";

export interface WebChatTodoItem {
	content: string;
	status: WebChatTodoStatus;
	blocker?: string;
}

export interface WebChatTodoPhase {
	name: string;
	tasks: WebChatTodoItem[];
}

export interface WebChatInfo {
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	provider?: string;
	modelId?: string;
}

export interface WebChatState extends WebChatInfo {
	running: boolean;
	streaming: boolean;
	compacting: boolean;
	sessionId: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: WebChatTodoPhase[];
}

export interface WebChatContentBlock {
	type:
		| "text"
		| "thinking"
		| "redactedThinking"
		| "image"
		| "toolCall"
		| "fallback"
		| "anthropicServerTool";
	text?: string;
	thinking?: string;
	data?: string;
	mimeType?: string;
	id?: string;
	name?: string;
	intent?: string;
}

export interface WebChatMessage {
	role: string;
	timestamp?: number;
	content: string | WebChatContentBlock[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	provider?: string;
	model?: string;
	stopReason?: string;
}

export interface WebChatNativeEvent {
	type: string;
	message?: WebChatMessage;
	messages?: WebChatMessage[];
	toolResults?: WebChatMessage[];
	toolCallId?: string;
	toolName?: string;
	intent?: string;
	isError?: boolean;
	level?: "info" | "warning" | "error";
	source?: string;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	success?: boolean;
	aborted?: boolean;
	willRetry?: boolean;
	model?: string;
	from?: string;
	to?: string;
	role?: string;
}

export interface WebChatEvent {
	chatId: string;
	event: WebChatNativeEvent;
}

export interface CreateWebChatInput {
	cwd: string;
	title?: string;
	provider?: string;
	modelId?: string;
}

export interface SetWebChatModelInput {
	provider: string;
	modelId: string;
}

export interface PromptWebChatInput {
	message: string;
	images?: WebChatImage[];
}

export interface WebChats {
	/** OS-temporary root containing metadata, sessions, and web-owned blobs. */
	readonly storageDir: string;
	list(): Promise<WebChatInfo[]>;
	create(input: CreateWebChatInput): Promise<WebChatInfo>;
	state(id: string): Promise<WebChatState>;
	messages(id: string): Promise<WebChatMessage[]>;
	models(id: string): Promise<WebChatModel[]>;
	setModel(
		id: string,
		input: SetWebChatModelInput,
	): Promise<{ provider: string; id: string }>;
	prompt(id: string, input: PromptWebChatInput): Promise<void>;
	abort(id: string): Promise<void>;
	/** Stop the process and permanently remove this chat's metadata. */
	closeChat(id: string): Promise<void>;
	/** Stop every live process while retaining metadata for daemon restart. */
	close(): Promise<void>;
}
