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

	// ── Management surface (T-605) ───────────────────────────────────────────

	/**
	 * Build the agent, creation, and notice panels here rather than in
	 * index.html: T-603 owns that file, and a client that constructs its own
	 * surface cannot fall out of step with the markup it was shipped beside.
	 *
	 * @param {string} tag
	 * @param {Record<string, string>} attributes
	 * @param {string} [text]
	 */
	const make = (tag, attributes, text) => {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes)) {
			node.setAttribute(key, value);
		}
		if (text !== undefined) node.textContent = text;
		return node;
	};

	const sidebar = el("sidebar");

	const newChannelForm = make("form", { id: "new-channel" });
	newChannelForm.append(
		make("input", {
			id: "new-channel-input",
			type: "text",
			placeholder: "#new-channel",
			autocomplete: "off",
		}),
		make("button", { id: "new-channel-create", type: "submit" }, "Create"),
	);
	const newChannelError = make("p", { id: "new-channel-error" });
	sidebar.append(newChannelForm, newChannelError);

	sidebar.append(make("h1", {}, "Agents"));
	const agentsEl = make("ul", { id: "agents" });
	sidebar.append(agentsEl);

	const newAgentForm = make("form", { id: "new-agent" });
	newAgentForm.append(
		make("input", {
			id: "new-agent-name",
			type: "text",
			placeholder: "name",
			autocomplete: "off",
		}),
		make("input", {
			id: "new-agent-description",
			type: "text",
			placeholder: "description",
			autocomplete: "off",
		}),
		make("input", {
			id: "new-agent-spawns",
			type: "text",
			placeholder: "spawns (comma separated)",
			autocomplete: "off",
		}),
		make("input", {
			id: "new-agent-rooms",
			type: "text",
			placeholder: "rooms (comma separated)",
			autocomplete: "off",
		}),
		make("textarea", {
			id: "new-agent-body",
			placeholder: "system prompt",
		}),
		make("button", { id: "new-agent-create", type: "submit" }, "Create agent"),
	);
	const newAgentError = make("p", { id: "new-agent-error" });
	sidebar.append(make("h1", {}, "New agent"), newAgentForm, newAgentError);

	// Step 7: say plainly which changes took effect now and which wait for a
	// rebuild. The daemon decides that, so the text is the server's, not ours.
	const noticeEl = make("p", { id: "notice", role: "status" });
	el("main").prepend(noticeEl);

	const newChannelInput = el("new-channel-input");
	const newAgentName = el("new-agent-name");
	const newAgentDescription = el("new-agent-description");
	const newAgentSpawns = el("new-agent-spawns");
	const newAgentRooms = el("new-agent-rooms");
	const newAgentBody = el("new-agent-body");

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
			// The daemon's own message, verbatim — for a refused definition it
			// is the parser's, and an operator has to read the same words the
			// daemon would print at boot, not a JSON-escaped envelope.
			const detail =
				payload && typeof payload === "object" && "error" in payload
					? payload.error
					: undefined;
			throw new Error(
				typeof detail?.message === "string"
					? detail.message
					: `HTTP ${response.status}`,
			);
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

	/**
	 * Agent rows with a membership toggle for the open channel.
	 *
	 * `data-member` carries the state a click will invert, so the rendered
	 * membership is readable without inferring it from the label.
	 * @param {{ name: string, state: string, rooms?: string[] }[]} agents
	 */
	const renderAgents = (agents) => {
		agentsEl.replaceChildren();
		for (const agent of agents) {
			const item = document.createElement("li");
			item.className = "agent";
			item.dataset.name = agent.name;

			const label = document.createElement("span");
			label.className = "agent-name";
			label.textContent = `${agent.name} (${agent.state})`;
			item.append(label);

			if (currentRoom !== null) {
				const member = (agent.rooms ?? []).includes(currentRoom);
				const toggle = document.createElement("button");
				toggle.type = "button";
				toggle.className = member
					? "membership-toggle member"
					: "membership-toggle";
				toggle.dataset.member = member ? "true" : "false";
				toggle.textContent = member ? "Leave" : "Join";
				const room = currentRoom;
				toggle.addEventListener("click", () => {
					void setMembership(agent.name, room, !member);
				});
				item.append(toggle);
			}
			agentsEl.append(item);
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

	/** Refetch the agent list, so membership renders for the open channel. */
	const refreshAgents = async () => {
		const { agents } = await api("/api/agents");
		renderAgents(
			/** @type {{ name: string, state: string, rooms?: string[] }[]} */ (
				agents
			),
		);
	};

	/** Refetch the channel list. */
	const refreshChannels = async () => {
		const { channels } = await api("/api/channels");
		renderChannels(/** @type {RoomInfo[]} */ (channels));
	};

	/** @param {string} room */
	const selectRoom = async (room) => {
		currentRoom = room;
		openThreadRoot = null;
		threadEl.hidden = true;
		currentChannelEl.textContent = room;
		await refresh();
		await refreshChannels();
		await refreshAgents();
	};

	/**
	 * Add or remove one agent from one channel.
	 *
	 * The daemon owns both halves — the definition on disk and the running
	 * peer's cached room set — and reports which of them took effect now, so
	 * the notice is the server's words rather than a guess made here.
	 * @param {string} name
	 * @param {string} room
	 * @param {boolean} join
	 */
	const setMembership = async (name, room, join) => {
		const path = `/api/agents/${encodeURIComponent(name)}/rooms`;
		const result = join
			? await api(path, { method: "POST", body: { room } })
			: await api(`${path}/${encodeURIComponent(room)}`, { method: "DELETE" });
		noticeEl.textContent =
			typeof result.notice === "string" ? result.notice : "";
		await refreshAgents();
	};

	/** @param {number} rootId */
	const openThread = async (rootId) => {
		openThreadRoot = rootId;
		threadEl.hidden = false;
		threadTitleEl.textContent = "Thread";
		await refresh();
	};

	/**
	 * Toggle the operator's own reaction through the daemon's reaction route,
	 * then refetch: the server is the transcript's source of truth and the
	 * poll feed races any local edit.
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

	/**
	 * Create a channel, then repaint the list from the server.
	 * @param {string} id
	 */
	const createChannel = async (id) => {
		newChannelError.textContent = "";
		try {
			await api("/api/channels", { method: "POST", body: { id } });
		} catch (error) {
			newChannelError.textContent =
				error instanceof Error ? error.message : String(error);
			return;
		}
		await refreshChannels();
		await refreshAgents();
	};

	/** Split a comma-separated field into trimmed, non-empty entries.
	 * @param {string} value
	 */
	const listField = (value) =>
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);

	/**
	 * Create an agent from the form.
	 *
	 * A refused definition renders the daemon's message — which is the
	 * parser's own — beside the form rather than being swallowed: the operator
	 * has to see the same words the daemon would print at boot.
	 */
	const createAgent = async () => {
		newAgentError.textContent = "";
		const rooms = listField(newAgentRooms.value);
		/** @type {Record<string, unknown>} */
		const payload = {
			name: newAgentName.value.trim(),
			description: newAgentDescription.value.trim(),
			spawns: listField(newAgentSpawns.value),
			body: newAgentBody.value,
		};
		// An empty list is omitted, not sent: the parser refuses `rooms: []`,
		// and an agent in no rooms simply has no `rooms:` key.
		if (rooms.length > 0) payload.rooms = rooms;

		/** @type {any} */
		let created;
		try {
			created = await api("/api/agents", { method: "POST", body: payload });
		} catch (error) {
			newAgentError.textContent =
				error instanceof Error ? error.message : String(error);
			return;
		}
		noticeEl.textContent =
			typeof created.notice === "string"
				? created.notice
				: "Agent created. It starts on the next daemon start.";
		newAgentName.value = "";
		newAgentDescription.value = "";
		newAgentSpawns.value = "";
		newAgentRooms.value = "";
		newAgentBody.value = "";
		await refreshChannels();
		await refreshAgents();
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

	newChannelForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const id = newChannelInput.value.trim();
		if (id.length === 0) return;
		newChannelInput.value = "";
		void createChannel(id);
	});

	newAgentForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void createAgent();
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
		// After the room is known: the membership toggle renders against the
		// open channel, so painting agents first would show every one of them
		// as a non-member.
		await refreshAgents();
		connect();
	};

	void boot();
})();
