/**
 * Purpose: The operator console (T-603). Channel list, transcript, composer,
 * thread side pane, and reaction chips, driven by the daemon's console API
 * (HTTP for reads and writes, WebSocket for live events). Vanilla JS with
 * JSDoc types — no build step; Bun serves this file to Chrome as-is.
 *
 * Wire shape consumed: `RoomMessage` and `RoomInfo` from src/shared/protocol
 * over /api/channels and /api/channels/:id/messages; `ConsoleEvent` frames
 * from /api/events. Token arrives as ?token= on the page URL, is sent on
 * HTTP as X-Operator-Token (the serving layer promotes it to Authorization),
 * and rides the WebSocket handshake as ?token= because a browser socket
 * cannot set headers.
 *
 * Failure modes: a dropped socket reconnects with backoff and refetches the
 * transcript, so a long agent turn cannot leave the view stale. Writes are
 * followed by a refetch rather than optimistic mutation: the server is the
 * transcript's source of truth and the poll feed races any local edit.
 */

/// <reference lib="dom" />
(() => {
	// ── Types (mirror src/rooms/store.ts and src/daemon/console-api.ts) ──────

	/** @typedef {{ id: string, kind: "channel" | "dm", name?: string }} RoomInfo */
	/** @typedef {{ actor: string, emoji: string }} MessageReaction */
	/**
	 * @typedef {object} RoomMessage
	 * @property {number} id
	 * @property {string} room
	 * @property {string} author
	 * @property {string} body
	 * @property {number} createdAt
	 * @property {number | null} parentId
	 * @property {number | null} threadRootId
	 * @property {number} replyCount
	 * @property {MessageReaction[]} reactions
	 */
	/**
	 * @typedef {{ type: "message", message: RoomMessage }
	 *   | { type: "reaction", room: string, messageId: number, actor: string, emoji: string }} ConsoleEvent
	 */

	const HUMAN_AUTHOR = "@you";
	const RECONNECT_BASE_MS = 200;
	const RECONNECT_CAP_MS = 5_000;

	// ── Config from the page URL ─────────────────────────────────────────────

	const params = new URLSearchParams(location.search);
	const token = params.get("token") ?? "";
	/** @type {string | null} */
	let currentRoom = params.get("room");
	/** @type {number | null} Message id whose thread is open in the side pane. */
	let openThreadRoot = null;

	// ── DOM ──────────────────────────────────────────────────────────────────

	/**
	 * @template {HTMLElement} T
	 * @param {string} id
	 * @returns {T}
	 */
	const el = (id) => {
		const node = document.getElementById(id);
		if (node === null) throw new Error(`Missing #${id}`);
		// DOM ids above are fixed by index.html; the shape is known.
		return /** @type {T} */ (node);
	};

	const channelsEl = el("channels");
	const messagesEl = el("messages");
	const currentChannelEl = el("current-channel");
	const composerEl = el("composer");
	const composerInput = el("composer-input");
	const threadEl = el("thread");
	const threadTitleEl = el("thread-title");
	const threadMessagesEl = el("thread-messages");
	const threadComposerEl = el("thread-composer");
	const threadComposerInput = el("thread-composer-input");

	// ── HTTP ─────────────────────────────────────────────────────────────────

	/**
	 * @param {string} path
	 * @param {{ method?: string, body?: unknown }} [init]
	 * @returns {Promise<any>} parsed JSON; throws on an error envelope.
	 */
	const api = async (path, init = {}) => {
		const response = await fetch(path, {
			method: init.method ?? "GET",
			headers: {
				"X-Operator-Token": token,
				...(init.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
		const payload = await response.json();
		if (!response.ok) {
			const message =
				payload && typeof payload === "object" && "error" in payload
					? JSON.stringify(payload.error)
					: `HTTP ${response.status}`;
			throw new Error(message);
		}
		return payload;
	};

	// ── Rendering ────────────────────────────────────────────────────────────

	/**
	 * Group reactions into chips of (emoji, count, mine).
	 * @param {MessageReaction[]} reactions
	 */
	const reactionChips = (reactions) => {
		/** @type {Map<string, { count: number, mine: boolean }>} */
		const byEmoji = new Map();
		for (const reaction of reactions) {
			const chip = byEmoji.get(reaction.emoji) ?? { count: 0, mine: false };
			chip.count += 1;
			if (reaction.actor === HUMAN_AUTHOR) chip.mine = true;
			byEmoji.set(reaction.emoji, chip);
		}
		return byEmoji;
	};

	/**
	 * One message row: author, body, reaction chips, thread affordance.
	 * @param {RoomMessage} message
	 * @param {boolean} inThread
	 */
	const renderMessage = (message, inThread) => {
		const row = document.createElement("div");
		row.className = "message";
		row.dataset.id = String(message.id);

		const author = document.createElement("span");
		author.className = "author";
		author.textContent = message.author;
		row.append(author);

		const body = document.createElement("span");
		body.className = "body";
		body.textContent = message.body;
		row.append(body);

		const chips = document.createElement("span");
		chips.className = "reactions";
		for (const [emoji, chip] of reactionChips(message.reactions)) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = chip.mine ? "reaction mine" : "reaction";
			button.textContent = `${emoji} ${chip.count}`;
			button.addEventListener("click", () => {
				void toggleReaction(message.id, emoji);
			});
			chips.append(button);
		}
		row.append(chips);

		if (!inThread && message.replyCount > 0) {
			const opener = document.createElement("button");
			opener.type = "button";
			opener.className = "thread-open";
			opener.textContent = `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`;
			opener.addEventListener("click", () => {
				void openThread(message.id);
			});
			row.append(opener);
		}
		return row;
	};

	/** @param {RoomMessage[]} messages */
	const renderTranscript = (messages) => {
		messagesEl.replaceChildren();
		for (const message of messages) {
			if (message.parentId !== null) continue;
			messagesEl.append(renderMessage(message, false));
		}
		messagesEl.scrollTop = messagesEl.scrollHeight;
	};

	/** @param {RoomMessage[]} messages */
	const renderThread = (messages) => {
		threadMessagesEl.replaceChildren();
		if (openThreadRoot === null) return;
		for (const message of messages) {
			if (message.threadRootId !== openThreadRoot) continue;
			threadMessagesEl.append(renderMessage(message, true));
		}
	};

	/** @param {RoomInfo[]} channels */
	const renderChannels = (channels) => {
		channelsEl.replaceChildren();
		for (const channel of channels) {
			const item = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			button.className =
				channel.id === currentRoom ? "channel active" : "channel";
			button.textContent = channel.name ?? channel.id;
			button.addEventListener("click", () => {
				void selectRoom(channel.id);
			});
			item.append(button);
			channelsEl.append(item);
		}
	};

	// ── State ────────────────────────────────────────────────────────────────

	/** Refetch the open room and repaint transcript + thread pane. */
	const refresh = async () => {
		if (currentRoom === null) return;
		const { messages } = await api(
			`/api/channels/${encodeURIComponent(currentRoom)}/messages`,
		);
		renderTranscript(/** @type {RoomMessage[]} */ (messages));
		renderThread(/** @type {RoomMessage[]} */ (messages));
	};

	/** @param {string} room */
	const selectRoom = async (room) => {
		currentRoom = room;
		openThreadRoot = null;
		threadEl.hidden = true;
		currentChannelEl.textContent = room;
		await refresh();
	};

	/** @param {number} rootId */
	const openThread = async (rootId) => {
		openThreadRoot = rootId;
		threadEl.hidden = false;
		threadTitleEl.textContent = "Thread";
		await refresh();
	};

	/**
	 * Toggle the operator's own reaction. The HTTP surface has no reaction
	 * route yet; this goes through the serving layer's toggle endpoint, which
	 * executes against the room store. Refetch renders canonical state.
	 * @param {number} messageId
	 * @param {string} emoji
	 */
	const toggleReaction = async (messageId, emoji) => {
		await api(`/api/messages/${messageId}/reactions/toggle`, {
			method: "POST",
			body: { actor: HUMAN_AUTHOR, emoji },
		});
		await refresh();
	};

	/**
	 * @param {string} body
	 * @param {number | null} parentId
	 */
	const postMessage = async (body, parentId) => {
		if (currentRoom === null) return;
		await api(`/api/channels/${encodeURIComponent(currentRoom)}/messages`, {
			method: "POST",
			body: { body, author: HUMAN_AUTHOR, parentId },
		});
		await refresh();
	};

	// ── Events ───────────────────────────────────────────────────────────────

	composerEl.addEventListener("submit", (event) => {
		event.preventDefault();
		const body = composerInput.value.trim();
		if (body.length === 0) return;
		composerInput.value = "";
		void postMessage(body, null);
	});

	threadComposerEl.addEventListener("submit", (event) => {
		event.preventDefault();
		const body = threadComposerInput.value.trim();
		if (body.length === 0 || openThreadRoot === null) return;
		threadComposerInput.value = "";
		void postMessage(body, openThreadRoot);
	});

	el("thread-close").addEventListener("click", () => {
		openThreadRoot = null;
		threadEl.hidden = true;
	});

	// ── Live feed with reconnect ─────────────────────────────────────────────

	// Exposed for tests: a harness can sever the socket in-page.
	const sockets = /** @type {WebSocket[]} */ ([]);
	window.__consoleSockets = sockets;

	/**
	 * Connect, and on drop reconnect with backoff and refetch. The refetch is
	 * the correctness point: frames missed while deaf are not replayed, so the
	 * transcript must be rebuilt from the store.
	 */
	let reconnectAttempts = 0;
	const connect = () => {
		const url = new URL("/api/events", location.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("token", token);
		const socket = new WebSocket(url);
		sockets.push(socket);

		socket.addEventListener("open", () => {
			reconnectAttempts = 0;
			// Refetch on open, not before it: a message landing between the
			// close and the new socket's open is missed by a pre-connect
			// refetch, and in a quiet room nothing would heal it.
			void refresh();
		});

		socket.addEventListener("message", (event) => {
			/** @type {ConsoleEvent} */
			const frame = JSON.parse(String(event.data));
			if (frame.type === "message" && frame.message.room === currentRoom) {
				void refresh();
			} else if (frame.type === "reaction" && frame.room === currentRoom) {
				void refresh();
			}
		});

		socket.addEventListener("close", () => {
			const index = sockets.indexOf(socket);
			if (index !== -1) sockets.splice(index, 1);
			reconnectAttempts += 1;
			const delay = Math.min(
				RECONNECT_BASE_MS * 2 ** reconnectAttempts,
				RECONNECT_CAP_MS,
			);
			setTimeout(() => {
				connect();
			}, delay);
		});
	};

	// ── Boot ─────────────────────────────────────────────────────────────────

	const boot = async () => {
		const { channels } = await api("/api/channels");
		renderChannels(/** @type {RoomInfo[]} */ (channels));
		if (currentRoom === null && channels.length > 0) {
			currentRoom = channels[0].id;
		}
		if (currentRoom !== null) {
			currentChannelEl.textContent = currentRoom;
			await refresh();
		}
		connect();
	};

	void boot();
})();
