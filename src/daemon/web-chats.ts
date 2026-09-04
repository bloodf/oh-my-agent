/**
 * Purpose: Own independent web chats backed by native OMP RPC subprocesses;
 * metadata and canonical OMP session JSONL stay in one OS-temporary root.
 *
 * Public API: `createWebChats({ stateDir, onEvent? }): Promise<WebChats>`.
 *
 * Upstream deps: native OMP `RpcClient`, `resolveOmpCli`, Node filesystem/path
 * and OS temporary-directory primitives, plus browser DTO allowlists.
 *
 * Downstream consumers: daemon web API composition. This module opens no HTTP
 * listener and exposes no generic RPC or shell passthrough.
 *
 * Failure modes: invalid/missing workspaces, non-temporary resume paths, and
 * corrupt metadata fail closed; subprocess/RPC failures retain native errors.
 * Failed new chats are stopped and rolled out of metadata. Daemon close stops
 * children but keeps temporary metadata; `closeChat` removes its metadata.
 *
 * Performance: one child per opened chat. Persisted chats reopen lazily; chat
 * mutations serialize per chat and metadata writes serialize globally.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type ModelInfo,
	RpcClient,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	CreateWebChatInput,
	PromptWebChatInput,
	SetWebChatModelInput,
	WebChatContentBlock,
	WebChatInfo,
	WebChatMessage,
	WebChatModel,
	WebChatNativeEvent,
	WebChats,
} from "../shared/web-workspace";
import { resolveOmpCli } from "../worker/lifecycle";

const TERMINAL_ID_ENV = {
	ZELLIJ_PANE_ID: "",
	ZELLIJ_SESSION_NAME: "",
	TMUX_PANE: "",
	CMUX_SURFACE_ID: "",
	KITTY_WINDOW_ID: "",
	WEZTERM_PANE: "",
	TERM_SESSION_ID: "",
	WT_SESSION: "",
};

const METADATA_FILE = "web-chats.json";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

interface PersistedChat extends WebChatInfo {
	sessionFile?: string;
}

interface LiveChat {
	client: RpcClient;
	unsubscribe: () => void;
	mutations: Promise<void>;
}

export interface CreateWebChatsOptions {
	/** Stable instance selector only; chat data is never written here. */
	stateDir: string;
	onEvent?: (chatId: string, event: WebChatNativeEvent) => void;
}
function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value.trim();
}

async function canonicalDirectory(path: string): Promise<string> {
	const input = requiredString(path, "cwd");
	let canonical: string;
	try {
		canonical = await realpath(input);
	} catch (cause) {
		throw new Error(`Chat workspace does not exist: ${input}`, { cause });
	}
	if (!(await stat(canonical)).isDirectory()) {
		throw new Error(`Chat workspace is not a directory: ${input}`);
	}
	return canonical;
}

function publicInfo(record: PersistedChat): WebChatInfo {
	return {
		id: record.id,
		title: record.title,
		cwd: record.cwd,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.provider === undefined ? {} : { provider: record.provider }),
		...(record.modelId === undefined ? {} : { modelId: record.modelId }),
	};
}

function parseMetadata(raw: string): PersistedChat[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed))
		throw new Error("Web chat metadata must be an array");
	return parsed.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error(`Invalid web chat metadata at index ${index}`);
		}
		const value = item as Record<string, unknown>;
		const createdAt = value.createdAt;
		const updatedAt = value.updatedAt;
		if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) {
			throw new Error(`Invalid web chat timestamps at index ${index}`);
		}
		const record: PersistedChat = {
			id: requiredString(value.id, `chat[${index}].id`),
			title: requiredString(value.title, `chat[${index}].title`),
			cwd: requiredString(value.cwd, `chat[${index}].cwd`),
			createdAt: createdAt as number,
			updatedAt: updatedAt as number,
		};
		if (value.provider !== undefined)
			record.provider = requiredString(
				value.provider,
				`chat[${index}].provider`,
			);
		if (value.modelId !== undefined)
			record.modelId = requiredString(value.modelId, `chat[${index}].modelId`);
		if (value.sessionFile !== undefined)
			record.sessionFile = requiredString(
				value.sessionFile,
				`chat[${index}].sessionFile`,
			);
		return record;
	});
}

function safeModel(model: ModelInfo): WebChatModel {
	return {
		provider: model.provider,
		id: model.id,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		...(model.thinking === undefined
			? {}
			: {
					thinking: {
						mode: model.thinking.mode,
						efforts: [...model.thinking.efforts],
						...(model.thinking.defaultLevel === undefined
							? {}
							: { defaultLevel: model.thinking.defaultLevel }),
					},
				}),
	};
}

function safeContent(content: unknown): string | WebChatContentBlock[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return [];
	return content.flatMap((item): WebChatContentBlock[] => {
		if (typeof item !== "object" || item === null) return [];
		const block = item as Record<string, unknown>;
		const type = typeof block.type === "string" ? block.type : "";
		switch (type) {
			case "text":
				return typeof block.text === "string"
					? [{ type, text: block.text }]
					: [];
			case "thinking":
				return typeof block.thinking === "string"
					? [{ type, thinking: block.thinking }]
					: [];
			case "redactedThinking":
				return [{ type }];
			case "image":
				return typeof block.data === "string" &&
					typeof block.mimeType === "string"
					? [{ type, data: block.data, mimeType: block.mimeType }]
					: [];
			case "toolCall":
				return typeof block.id === "string" && typeof block.name === "string"
					? [
							{
								type,
								id: block.id,
								name: block.name,
								...(typeof block.intent === "string"
									? { intent: block.intent }
									: {}),
							},
						]
					: [];
			case "fallback":
			case "anthropicServerTool":
				return [{ type }];
			default:
				return [];
		}
	});
}

function safeMessage(message: AgentMessage): WebChatMessage {
	const raw = message as unknown as Record<string, unknown>;
	const role = typeof raw.role === "string" ? raw.role : "unknown";
	return {
		role,
		// Tool results may contain file contents, environment output, or secrets.
		// Native JSONL remains canonical; browser transport receives no result body.
		content: role === "toolResult" ? [] : safeContent(raw.content),
		...(typeof raw.timestamp === "number" ? { timestamp: raw.timestamp } : {}),
		...(typeof raw.toolCallId === "string"
			? { toolCallId: raw.toolCallId }
			: {}),
		...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
		...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
		...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
		...(typeof raw.model === "string" ? { model: raw.model } : {}),
		...(typeof raw.stopReason === "string"
			? { stopReason: raw.stopReason }
			: {}),
	};
}

function safeEvent(event: AgentSessionEvent): WebChatNativeEvent {
	const raw = event as unknown as Record<string, unknown>;
	const output: WebChatNativeEvent = { type: event.type };
	if (raw.message && typeof raw.message === "object")
		output.message = safeMessage(raw.message as AgentMessage);
	if (Array.isArray(raw.messages))
		output.messages = raw.messages.map((message) =>
			safeMessage(message as AgentMessage),
		);
	if (Array.isArray(raw.toolResults))
		output.toolResults = raw.toolResults.map((message) =>
			safeMessage(message as AgentMessage),
		);
	for (const key of [
		"toolCallId",
		"toolName",
		"intent",
		"source",
		"model",
		"from",
		"to",
		"role",
	] as const) {
		if (typeof raw[key] === "string") output[key] = raw[key];
	}
	for (const key of ["attempt", "maxAttempts", "delayMs"] as const) {
		if (typeof raw[key] === "number") output[key] = raw[key];
	}
	for (const key of ["isError", "success", "aborted", "willRetry"] as const) {
		if (typeof raw[key] === "boolean") output[key] = raw[key];
	}
	if (raw.level === "info" || raw.level === "warning" || raw.level === "error")
		output.level = raw.level;
	return output;
}

export async function createWebChats(
	options: CreateWebChatsOptions,
): Promise<WebChats> {
	const instanceSelector = resolve(
		requiredString(options.stateDir, "stateDir"),
	);
	const instanceHash = createHash("sha256")
		.update(instanceSelector)
		.digest("hex")
		.slice(0, 16);
	const owner =
		typeof process.getuid === "function" ? String(process.getuid()) : "user";
	const storageDir = join(tmpdir(), `oh-my-agent-web-${owner}-${instanceHash}`);
	const sessionDir = join(storageDir, "sessions");
	await mkdir(sessionDir, { recursive: true, mode: DIRECTORY_MODE });
	await chmod(storageDir, DIRECTORY_MODE);
	await chmod(sessionDir, DIRECTORY_MODE);
	const metadataPath = join(storageDir, METADATA_FILE);
	let records: PersistedChat[];
	try {
		records = parseMetadata(await readFile(metadataPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		records = [];
	}
	const byId = new Map(records.map((record) => [record.id, record]));
	if (byId.size !== records.length)
		throw new Error("Web chat metadata contains duplicate IDs");
	if (records.length > 0) await chmod(metadataPath, FILE_MODE);
	const live = new Map<string, LiveChat>();
	const starts = new Map<string, Promise<LiveChat>>();
	let closed = false;
	let persistence = Promise.resolve();

	const persist = async (): Promise<void> => {
		const snapshot = `${JSON.stringify([...byId.values()], null, 2)}\n`;
		const write = persistence.then(async () => {
			const staging = join(storageDir, `.${METADATA_FILE}.${randomUUID()}.tmp`);
			try {
				await writeFile(staging, snapshot, {
					encoding: "utf8",
					mode: FILE_MODE,
				});
				await chmod(staging, FILE_MODE);
				await rename(staging, metadataPath);
				await chmod(metadataPath, FILE_MODE);
			} catch (error) {
				await unlink(staging).catch(() => {});
				throw error;
			}
		});
		persistence = write.catch(() => {});
		await write;
	};

	const recordFor = (id: string): PersistedChat => {
		if (closed) throw new Error("Web chat service is closed");
		const key = requiredString(id, "chat id");
		const record = byId.get(key);
		if (!record) throw new Error(`Unknown web chat: ${key}`);
		return record;
	};
	const sessionPath = (path: string): string => {
		const canonical = resolve(path);
		if (!canonical.startsWith(`${sessionDir}${sep}`)) {
			throw new Error(
				`Refusing web chat session outside temporary storage: ${path}`,
			);
		}
		return canonical;
	};
	const materializedSessionPath = async (
		path: string,
	): Promise<string | undefined> => {
		const canonical = sessionPath(path);
		try {
			return (await stat(canonical)).isFile() ? canonical : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};

	const launch = async (record: PersistedChat): Promise<LiveChat> => {
		const cwd = await canonicalDirectory(record.cwd);
		if (cwd !== record.cwd) {
			record.cwd = cwd;
			record.updatedAt = Date.now();
			await persist();
		}
		const client = new RpcClient({
			cwd,
			cliPath: resolveOmpCli(),
			sessionDir,
			env: TERMINAL_ID_ENV,
			...(record.provider === undefined ? {} : { provider: record.provider }),
			...(record.modelId === undefined ? {} : { model: record.modelId }),
			...(record.sessionFile === undefined
				? {}
				: { args: ["--session", sessionPath(record.sessionFile)] }),
		});
		const unsubscribe = client.onSessionEvent((event) => {
			options.onEvent?.(record.id, safeEvent(event));
			if (event.type !== "agent_end") return;
			const current = live.get(record.id);
			if (
				!current ||
				current.client !== client ||
				byId.get(record.id) !== record
			)
				return;
			void mutate(current, async () => {
				if (closed || byId.get(record.id) !== record) return;
				record.updatedAt = Date.now();
				await refresh(record, current);
				await persist();
			}).catch(() => {});
		});
		try {
			await client.start();
			const state = await client.getState();
			if (state.sessionFile !== undefined) {
				const nextSessionFile = await materializedSessionPath(
					state.sessionFile,
				);
				if (
					nextSessionFile !== undefined &&
					nextSessionFile !== record.sessionFile
				) {
					record.sessionFile = nextSessionFile;
					record.updatedAt = Date.now();
					await persist();
				}
			}
		} catch (error) {
			unsubscribe();
			await client.stop().catch(() => {});
			throw error;
		}
		if (closed || byId.get(record.id) !== record) {
			unsubscribe();
			await client.stop();
			throw new Error(`Web chat ${record.id} closed during startup`);
		}
		const opened = { client, unsubscribe, mutations: Promise.resolve() };
		live.set(record.id, opened);
		const watchExit = (): void => {
			const timer = setTimeout(() => {
				if (client.pid !== undefined) {
					watchExit();
					return;
				}
				if (live.get(record.id)?.client !== client) return;
				live.delete(record.id);
				unsubscribe();
			}, 1_000);
			timer.unref();
		};
		watchExit();
		return opened;
	};

	const start = async (record: PersistedChat): Promise<LiveChat> => {
		const existing = live.get(record.id);
		if (existing?.client.pid !== undefined) return existing;
		if (existing) {
			existing.unsubscribe();
			live.delete(record.id);
			await existing.client.stop().catch(() => {});
		}
		const pending = starts.get(record.id);
		if (pending) return await pending;
		const launching = launch(record);
		starts.set(record.id, launching);
		try {
			return await launching;
		} finally {
			if (starts.get(record.id) === launching) starts.delete(record.id);
		}
	};

	const opened = async (
		id: string,
	): Promise<{ record: PersistedChat; chat: LiveChat }> => {
		const record = recordFor(id);
		return { record, chat: await start(record) };
	};

	const mutate = async <T>(
		chat: LiveChat,
		operation: () => Promise<T>,
	): Promise<T> => {
		const guarded = async (): Promise<T> => {
			if (closed || chat.client.pid === undefined)
				throw new Error("Web chat is closed");
			return await operation();
		};
		const run = chat.mutations.then(guarded, guarded);
		chat.mutations = run.then(
			() => {},
			() => {},
		);
		return await run;
	};

	const refresh = async (
		record: PersistedChat,
		chat: LiveChat,
	): Promise<RpcSessionState> => {
		const state = await chat.client.getState();
		let dirty = false;
		if (state.sessionFile !== undefined) {
			const nextSessionFile = await materializedSessionPath(state.sessionFile);
			if (
				nextSessionFile !== undefined &&
				nextSessionFile !== record.sessionFile
			) {
				record.sessionFile = nextSessionFile;
				dirty = true;
			}
		}
		if (
			state.model &&
			(record.provider !== state.model.provider ||
				record.modelId !== state.model.id)
		) {
			record.provider = state.model.provider;
			record.modelId = state.model.id;
			dirty = true;
		}
		if (dirty) {
			record.updatedAt = Date.now();
			await persist();
		}
		return state;
	};

	return {
		storageDir,
		list: async () => {
			if (closed) throw new Error("Web chat service is closed");
			return [...byId.values()]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map(publicInfo);
		},
		create: async (input: CreateWebChatInput) => {
			if (closed) throw new Error("Web chat service is closed");
			const cwd = await canonicalDirectory(input.cwd);
			const provider =
				input.provider === undefined
					? undefined
					: requiredString(input.provider, "provider");
			const modelId =
				input.modelId === undefined
					? undefined
					: requiredString(input.modelId, "modelId");
			if ((provider === undefined) !== (modelId === undefined)) {
				throw new Error("provider and modelId must be supplied together");
			}
			const now = Date.now();
			const record: PersistedChat = {
				id: randomUUID(),
				title:
					input.title === undefined
						? basename(cwd)
						: requiredString(input.title, "title"),
				cwd,
				createdAt: now,
				updatedAt: now,
				...(provider === undefined ? {} : { provider }),
				...(modelId === undefined ? {} : { modelId }),
			};
			byId.set(record.id, record);
			let chat: LiveChat | undefined;
			try {
				chat = await start(record);
				await refresh(record, chat);
				await persist();
			} catch (error) {
				byId.delete(record.id);
				starts.delete(record.id);
				live.delete(record.id);
				chat?.unsubscribe();
				await chat?.client.stop().catch(() => {});
				await persist();
				throw error;
			}
			return publicInfo(record);
		},
		state: async (id) => {
			const { record, chat } = await opened(id);
			const state = await refresh(record, chat);
			return {
				...publicInfo(record),
				running: chat.client.pid !== undefined,
				streaming: state.isStreaming,
				compacting: state.isCompacting,
				sessionId: state.sessionId,
				...(state.model === undefined
					? {}
					: { model: { provider: state.model.provider, id: state.model.id } }),
				...(state.thinkingLevel === undefined
					? {}
					: { thinkingLevel: state.thinkingLevel }),
				messageCount: state.messageCount,
				queuedMessageCount: state.queuedMessageCount,
				todoPhases: state.todoPhases,
			};
		},
		messages: async (id) =>
			(await (await opened(id)).chat.client.getMessages()).map(safeMessage),
		models: async (id) =>
			(await (await opened(id)).chat.client.getAvailableModels()).map(
				safeModel,
			),
		setModel: async (id: string, input: SetWebChatModelInput) => {
			const { record, chat } = await opened(id);
			const provider = requiredString(input.provider, "provider");
			const modelId = requiredString(input.modelId, "modelId");
			return await mutate(chat, async () => {
				if (byId.get(record.id) !== record || live.get(record.id) !== chat) {
					throw new Error(`Web chat ${record.id} is closed`);
				}
				const selected = await chat.client.setModel(provider, modelId);
				record.provider = selected.provider;
				record.modelId = selected.id;
				record.updatedAt = Date.now();
				await persist();
				return selected;
			});
		},
		prompt: async (id: string, input: PromptWebChatInput) => {
			const { record, chat } = await opened(id);
			const message = requiredString(input.message, "message");
			const images = input.images?.map((image, index) => {
				if (
					image.detail !== undefined &&
					!["auto", "low", "high", "original"].includes(image.detail)
				) {
					throw new Error(`images[${index}].detail is invalid`);
				}
				return {
					type: "image" as const,
					data: requiredString(image.data, `images[${index}].data`),
					mimeType: requiredString(image.mimeType, `images[${index}].mimeType`),
					...(image.detail === undefined ? {} : { detail: image.detail }),
				};
			});
			await mutate(chat, async () => {
				if (byId.get(record.id) !== record || live.get(record.id) !== chat) {
					throw new Error(`Web chat ${record.id} is closed`);
				}
				await chat.client.prompt(message, images);
				record.updatedAt = Date.now();
				await refresh(record, chat);
			});
		},
		abort: async (id) => {
			const { chat } = await opened(id);
			await chat.client.abort();
		},
		closeChat: async (id) => {
			const record = recordFor(id);
			byId.delete(record.id);
			const pending = starts.get(record.id);
			if (pending) await pending.catch(() => {});
			const chat = live.get(record.id);
			if (chat) {
				live.delete(record.id);
				chat.unsubscribe();
				await chat.client.stop();
			}
			await persist();
		},
		close: async () => {
			if (closed) return;
			closed = true;
			const running = [...live.values()];
			live.clear();
			await Promise.allSettled(
				running.map(async (chat) => {
					chat.unsubscribe();
					await chat.client.stop();
				}),
			);
			await Promise.allSettled(starts.values());
			await persistence;
		},
	};
}
