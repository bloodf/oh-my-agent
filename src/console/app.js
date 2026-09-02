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
 * open transcript plus background-room activity, healing missed frames.
 * Writes are followed by a refetch rather than optimistic mutation: the
 * server is the transcript's source of truth and the poll feed races edits.
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
	 * @property {string[]} [mentions]
	 * @property {number | null} parentId
	 * @property {number | null} threadRootId
	 * @property {number} replyCount
	 * @property {MessageReaction[]} reactions
	 */
	/**
	 * Frames the daemon pushes (ADR-015). Additive: this shell may be a
	 * cached build older than the daemon, so an unrecognised `type` is
	 * ignored rather than treated as an error.
	 * @typedef {{ type: "message", message: RoomMessage }
	 *   | { type: "reaction", room: string, messageId: number, actor: string,
	 *       emoji: string, reacted: boolean }
	 *   | { type: "agent", agent: string, state: string }
	 *   | { type: "definition", agent: string, rebuildRequired: boolean }
	 *   | { type: "membership", agent: string, rooms: string[] }
	 *   | { type: "channel", channel: RoomInfo }
	 *   | { type: "budget", account: string, state: string, budgetUsd?: number }
	 *   | { type: "schedule", agent: string, phase: "armed" | "fired" }} ConsoleEvent
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
	const stateEl = el("state");
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
	 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [init]
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
				// Last, so a caller can name what a request is for — a test proxy
				// scopes a fault by that marker rather than by guessing from the
				// query string, which any later caller could collide with.
				...init.headers,
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

	/** Own an event callback's Promise so failures never become unhandled.
	 * @param {Promise<unknown>} promise
	 */
	const run = (promise) => {
		void promise.catch((error) => console.error(error));
	};

	// ── Rendering ────────────────────────────────────────────────────────────

	/**
	 * Role class for an author: the operator, the system, or an agent. The
	 * tint itself lives in the token layer (style.css); this only names the
	 * role so presentation stays in CSS.
	 * @param {string} author
	 */
	const roleClass = (author) => {
		if (author === HUMAN_AUTHOR) return "role-you";
		if (author === "system") return "role-system";
		return "role-agent";
	};

	/**
	 * A readable wall-clock stamp for a message. Minutes are zero-padded;
	 * hours follow the locale's clock.
	 * @param {number} createdAt
	 */
	const timestamp = (createdAt) => {
		const when = new Date(createdAt);
		return `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
	};

	/**
	 * Message body with fenced code lifted into <pre>. Everything goes
	 * through textContent — the fence parser only decides which element a
	 * line lands in, never how it is escaped.
	 * @param {string} body
	 */
	const renderBody = (body) => {
		const container = document.createElement("div");
		container.className = "body";
		const lines = body.split("\n");
		/** @type {string[]} */
		let prose = [];
		/** @type {string[] | null} */
		let fence = null;
		const flushProse = () => {
			if (prose.length === 0) return;
			const paragraph = document.createElement("p");
			paragraph.textContent = prose.join("\n");
			container.append(paragraph);
			prose = [];
		};
		for (const line of lines) {
			if (line.trim().startsWith("```")) {
				if (fence === null) {
					flushProse();
					fence = [];
				} else {
					const pre = document.createElement("pre");
					pre.textContent = fence.join("\n");
					container.append(pre);
					fence = null;
				}
				continue;
			}
			if (fence !== null) fence.push(line);
			else prose.push(line);
		}
		// An unclosed fence is still the author's text, not lost input.
		if (fence !== null) prose = [...prose, "```", ...fence];
		flushProse();
		return container;
	};

	/**
	 * Group reactions by emoji, keeping the actors behind each chip.
	 *
	 * The actors, not just a count, are what make a live update idempotent: a
	 * frame applies as a set insert or delete, so the same actor's reaction
	 * arriving twice — a frame landing on top of the snapshot the socket-open
	 * refetch already painted — cannot count them twice.
	 * @param {MessageReaction[]} reactions
	 * @returns {Map<string, string[]>} emoji to its actors
	 */
	const reactionChips = (reactions) => {
		/** @type {Map<string, string[]>} */
		const byEmoji = new Map();
		for (const reaction of reactions) {
			const actors = byEmoji.get(reaction.emoji) ?? [];
			if (!actors.includes(reaction.actor)) actors.push(reaction.actor);
			byEmoji.set(reaction.emoji, actors);
		}
		return byEmoji;
	};

	/**
	 * Paint one chip's label and state from the actors behind it.
	 *
	 * The actor list rides on the element as JSON because an actor name is
	 * free text: a delimited string would split on a name containing the
	 * delimiter and lose somebody's reaction.
	 * @param {HTMLElement} chip
	 * @param {string} emoji
	 * @param {string[]} actors
	 */
	const paintChip = (chip, emoji, actors) => {
		const mine = actors.includes(HUMAN_AUTHOR);
		chip.className = mine ? "reaction mine" : "reaction";
		chip.dataset.emoji = emoji;
		chip.dataset.actors = JSON.stringify(actors);
		chip.setAttribute("aria-pressed", mine ? "true" : "false");
		chip.setAttribute(
			"aria-label",
			`React with ${emoji}, ${actors.length} so far`,
		);
		chip.textContent = `${emoji} ${actors.length}`;
	};

	/**
	 * The actors behind a rendered chip, as it last painted.
	 * @param {HTMLElement} chip
	 * @returns {string[]}
	 */
	const chipActors = (chip) => {
		try {
			const parsed = JSON.parse(chip.dataset.actors ?? "[]");
			// `data-actors` is DOM text and a page can be edited in place, so
			// the parse is narrowed to actor ids: a number or an object left
			// in the array would otherwise be compared against a real actor by
			// `includes` and silently never match.
			return Array.isArray(parsed)
				? parsed.filter((actor) => typeof actor === "string")
				: [];
		} catch {
			// A hand-edited or truncated attribute is not worth a broken feed.
			return [];
		}
	};

	/**
	 * One reaction chip, ready to append.
	 *
	 * Shared with the live-feed handler, which builds a chip for an emoji
	 * nobody had used yet: a chip built there by hand would drift from this
	 * one the first time the label or the pressed state changes.
	 * @param {number} messageId
	 * @param {string} emoji
	 * @param {string[]} actors
	 */
	const renderChip = (messageId, emoji, actors) => {
		const button = document.createElement("button");
		button.type = "button";
		paintChip(button, emoji, actors);
		button.addEventListener("click", () => {
			run(toggleReaction(messageId, emoji));
		});
		return button;
	};

	/**
	 * One message row: author, body, reaction chips, thread affordance.
	 * A grouped row continues its predecessor's run: same author, no header.
	 * @param {RoomMessage} message
	 * @param {boolean} inThread
	 * @param {boolean} grouped
	 */
	const renderMessage = (message, inThread, grouped) => {
		const row = document.createElement("div");
		row.className = `message ${roleClass(message.author)}${grouped ? " grouped" : ""}`;
		row.dataset.id = String(message.id);

		if (!grouped) {
			const meta = document.createElement("div");
			meta.className = "meta";

			const author = document.createElement("span");
			author.className = "author";
			author.textContent = message.author;
			meta.append(author);

			const stamp = document.createElement("span");
			stamp.className = "timestamp";
			stamp.textContent = timestamp(message.createdAt);
			meta.append(stamp);

			row.append(meta);
		}

		row.append(renderBody(message.body));

		for (const mention of message.mentions ?? []) {
			const chip = document.createElement("span");
			chip.className = "mention";
			chip.textContent = `@${mention}`;
			row.append(chip);
		}

		const chips = document.createElement("span");
		chips.className = "reactions";
		for (const [emoji, actors] of reactionChips(message.reactions)) {
			chips.append(renderChip(message.id, emoji, actors));
		}
		row.append(chips);

		if (!inThread && message.replyCount > 0) {
			const opener = document.createElement("button");
			opener.type = "button";
			opener.className = "thread-open";
			opener.textContent = `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`;
			opener.addEventListener("click", () => {
				run(openThread(message.id));
			});
			row.append(opener);
		}
		return row;
	};

	// ── Repaint focus and scroll stability (T-1615) ──────────────────────────

	/**
	 * @typedef {object} FocusKey
	 * @property {string} kind Control class: `reaction`, `thread-open`, `channel`.
	 * @property {string} id Identity within that kind; `""` when the kind is
	 *   unique inside its row.
	 * @property {string | null} rowId `.message[data-id]` the control sits in,
	 *   or `null` for a control that is not inside a message row.
	 */

	/**
	 * Stable identity of one focusable control, or `null` when it has none.
	 *
	 * Identity, never ordinal, and never the class list: `mine`, `active`, and
	 * `unread` are all toggled by the very updates that trigger a repaint, so
	 * a key built from every class stops matching the control it came from at
	 * exactly the moment a restore is needed. An ordinal is worse still — a
	 * reaction added or removed ahead of the focused chip shifts every index
	 * below it, and the restore lands on a *different emoji*.
	 * @param {HTMLElement} element
	 * @returns {{ kind: string, id: string } | null}
	 */
	const controlIdentity = (element) => {
		// "👀 2" carries a count that changes on every repaint, so only the
		// emoji segment is identity.
		if (element.classList.contains("reaction")) {
			return {
				kind: "reaction",
				id: (element.textContent ?? "").split(" ")[0] ?? "",
			};
		}
		if (element.classList.contains("thread-open")) {
			return { kind: "thread-open", id: "" };
		}
		if (element.classList.contains("channel")) {
			return { kind: "channel", id: element.dataset.id ?? "" };
		}
		// Operations controls repeat once per agent, so the row's agent name
		// is the identity — `kind` alone would restore focus onto whichever
		// "Stop" button happened to render first, which is a different agent.
		for (const kind of ["ops-kill", "ops-logs", "ops-inject-input"]) {
			if (!element.classList.contains(kind)) continue;
			const row = element.closest(".ops-agent");
			return {
				kind,
				id: row instanceof HTMLElement ? (row.dataset.name ?? "") : "",
			};
		}
		if (element.classList.contains("ops-bump-input")) {
			const row = element.closest(".ops-account");
			return {
				kind: "ops-bump-input",
				id: row instanceof HTMLElement ? (row.dataset.account ?? "") : "",
			};
		}
		// The definition opener repeats once per agent in the rail, and it
		// carries its own agent name — the row it sits in is `.agent`, not an
		// ops row, so it needs its own case. Without one, `captureFocus`
		// returns null for it and the editor's Escape has nothing to restore.
		if (element.classList.contains("definition-edit")) {
			return {
				kind: "definition-edit",
				id: element.dataset.name ?? "",
			};
		}
		return null;
	};

	/**
	 * Identity of the control focus sits on inside `container`, or `null`.
	 *
	 * `null` when focus is elsewhere, on the container itself (which survives
	 * a repaint of its children), or on a control with no stable identity —
	 * in every one of those cases a repaint has nothing to restore.
	 * @param {HTMLElement} container
	 * @returns {FocusKey | null}
	 */
	const captureFocus = (container) => {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement)) return null;
		if (active === container || !container.contains(active)) return null;
		const identity = controlIdentity(active);
		if (identity === null) return null;
		const row = active.closest(".message");
		return {
			...identity,
			rowId: row instanceof HTMLElement ? (row.dataset.id ?? null) : null,
		};
	};

	/**
	 * Put focus back on the control `key` names, or give it up cleanly.
	 *
	 * Fallback rule: an identity that is gone drops focus to the container
	 * when the container can hold focus, and to `<body>` otherwise. Never a
	 * sibling and never the first match — the neighbours of a reaction chip
	 * are other reactions, so re-pointing the keyboard at one of them means
	 * the operator's next Enter posts a reaction they never chose.
	 * @param {HTMLElement} container
	 * @param {FocusKey | null} key
	 */
	const restoreFocus = (container, key) => {
		if (key === null) return;
		const scope =
			key.rowId === null
				? container
				: container.querySelector(
						`.message[data-id="${CSS.escape(key.rowId)}"]`,
					);
		for (const candidate of scope?.querySelectorAll(`.${key.kind}`) ?? []) {
			if (!(candidate instanceof HTMLElement)) continue;
			if (controlIdentity(candidate)?.id !== key.id) continue;
			candidate.focus();
			return;
		}
		// The identity is gone. Fall back to the container when it can hold
		// focus — `#messages` carries a tabindex for keyboard scrolling — and
		// otherwise blur to `<body>` explicitly. `#thread-messages` is not
		// focusable, and leaving focus wherever the browser happens to drop it
		// after a node is removed is exactly the unpredictability this rule
		// exists to forbid.
		if (container.tabIndex >= 0) {
			container.focus();
			return;
		}
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	};

	/**
	 * Distance in px from the bottom of a scroll box, `0` when it does not
	 * scroll. Sub-pixel layout means an "at the bottom" box rarely reports
	 * exactly `0`, so callers compare against a small threshold.
	 * @param {HTMLElement} box
	 */
	const distanceFromBottom = (box) =>
		box.scrollHeight - box.scrollTop - box.clientHeight;

	/** Under this many px from the bottom counts as "reading the newest". */
	const STICKY_BOTTOM_PX = 4;

	/** @param {RoomMessage[]} messages */
	const renderTranscript = (messages) => {
		const focusKey = captureFocus(messagesEl);
		// Pin to the bottom only for a reader who was already there. Slamming
		// scrollTop unconditionally yanks anyone reading history back to the
		// newest line on every live update, with no way back to their place.
		const wasAtBottom = distanceFromBottom(messagesEl) < STICKY_BOTTOM_PX;
		const previousTop = messagesEl.scrollTop;
		messagesEl.replaceChildren();
		/** @type {string | null} */
		let previousAuthor = null;
		for (const message of messages) {
			if (message.parentId !== null) continue;
			messagesEl.append(
				renderMessage(message, false, message.author === previousAuthor),
			);
			previousAuthor = message.author;
		}
		if (wasAtBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
		else messagesEl.scrollTop = previousTop;
		restoreFocus(messagesEl, focusKey);
	};

	/** @param {RoomMessage[]} messages */
	const renderThread = (messages) => {
		// The pane repaints inside the same refresh() as the transcript, so it
		// needs the same protection: a reply landing while the operator is on
		// a chip in the pane must not throw focus out of it.
		const focusKey = captureFocus(threadMessagesEl);
		threadMessagesEl.replaceChildren();
		// Restore before the early return too: a pane that just closed has
		// destroyed whatever the operator was focused on, and leaving focus
		// on a detached node strands the keyboard with nothing to act on.
		if (openThreadRoot === null) {
			restoreFocus(threadMessagesEl, focusKey);
			return;
		}
		/** @type {string | null} */
		let previousAuthor = null;
		for (const message of messages) {
			if (message.threadRootId !== openThreadRoot) continue;
			threadMessagesEl.append(
				renderMessage(message, true, message.author === previousAuthor),
			);
			previousAuthor = message.author;
		}
		restoreFocus(threadMessagesEl, focusKey);
	};

	/**
	 * Rooms with activity the operator has not looked at. The open room never
	 * enters the set; visiting a room removes it.
	 * @type {Set<string>}
	 */
	const unreadRooms = new Set();

	/** Latest message id loaded while each room was open. @type {Map<string, number>} */
	const lastSeen = new Map();

	/** @type {RoomInfo[]} Last channel list, so unread can repaint alone. */
	let lastChannels = [];

	/** @param {RoomInfo[]} channels */
	const renderChannels = (channels) => {
		// Keyed by channel id, not by the roving tabindex: the roving option
		// is whichever room is *open*, which is rarely the option the operator
		// has arrowed focus onto, so restoring "the option in the tab order"
		// silently moves focus to a different channel.
		const focusKey = captureFocus(channelsEl);
		channelsEl.replaceChildren();
		// Roving tabindex: exactly one option sits in the tab order — the
		// open room, or the first option before any room is open.
		const rovingId =
			channels.some((channel) => channel.id === currentRoom) &&
			currentRoom !== null
				? currentRoom
				: (channels[0]?.id ?? null);
		for (const channel of channels) {
			const item = document.createElement("li");
			item.setAttribute("role", "presentation");
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "option");
			button.setAttribute(
				"aria-selected",
				channel.id === currentRoom ? "true" : "false",
			);
			button.tabIndex = channel.id === rovingId ? 0 : -1;
			const classes = ["channel"];
			if (channel.id === currentRoom) classes.push("active");
			if (unreadRooms.has(channel.id)) classes.push("unread");
			button.className = classes.join(" ");
			// The rendered label is `name ?? id` and a name is free text, so
			// the id rides along as the option's identity for focus restore.
			button.dataset.id = channel.id;
			button.textContent = channel.name ?? channel.id;
			button.addEventListener("click", () => {
				run(selectRoom(channel.id));
			});
			item.append(button);
			channelsEl.append(item);
		}
		restoreFocus(channelsEl, focusKey);
	};

	// Arrow keys rove focus through the options without selecting; Enter or
	// Space activates the focused option (the button's native click).
	channelsEl.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const options = /** @type {HTMLElement[]} */ ([
			...channelsEl.querySelectorAll(".channel"),
		]);
		const index = options.indexOf(
			/** @type {HTMLElement} */ (document.activeElement),
		);
		if (index === -1 || options.length === 0) return;
		event.preventDefault();
		const step = event.key === "ArrowDown" ? 1 : -1;
		const next = options[(index + step + options.length) % options.length];
		for (const option of options) {
			option.tabIndex = option === next ? 0 : -1;
		}
		next.focus();
	});

	/**
	 * Agent rows with a membership toggle for the open channel.
	 *
	 * `data-member` carries the state a click will invert, so the rendered
	 * membership is readable without inferring it from the label.
	 * @param {{ name: string, state: string, rooms?: string[] }[]} agents
	 */
	const renderAgents = (agents) => {
		// The rail repaints on every agent/definition/membership frame, and it
		// now holds a keyboard-reachable control per row. Without capture and
		// restore, a frame landing while the operator is on an "Edit" button
		// drops focus to `<body>` mid-keystroke (T-1615).
		const focusKey = captureFocus(agentsEl);
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
					run(setMembership(agent.name, room, !member));
				});
				item.append(toggle);
			}

			// The definition opener, per agent. In the agents rail rather than
			// the ops panel: editing a definition is authoring, not an
			// operation on a running worker — a stopped agent is just as
			// editable as a live one.
			const edit = document.createElement("button");
			edit.type = "button";
			edit.className = "definition-edit";
			edit.dataset.name = agent.name;
			// The name rides in the accessible name: a rail of identical
			// "Edit" buttons tells a screen-reader user nothing about which
			// definition they are about to open.
			edit.setAttribute("aria-label", `Edit ${agent.name}'s definition`);
			edit.textContent = "Edit";
			edit.addEventListener("click", () => {
				run(openDefinition(agent.name));
			});
			item.append(edit);
			agentsEl.append(item);
		}
		restoreFocus(agentsEl, focusKey);
	};

	// ── Operations (T-1605) ──────────────────────────────────────────────────

	const opsAgentsEl = el("ops-agents");
	const opsAccountsEl = el("ops-accounts");
	const agentTemplate = /** @type {HTMLTemplateElement} */ (
		el("ops-agent-template")
	);
	const accountTemplate = /** @type {HTMLTemplateElement} */ (
		el("ops-account-template")
	);
	const opsErrorEl = el("ops-error");
	const opsLogsEl = el("ops-logs-output");
	const killDialog = /** @type {HTMLDialogElement} */ (el("ops-kill-dialog"));
	const killDetailEl = el("ops-kill-detail");
	const killKeepEl = /** @type {HTMLInputElement} */ (el("ops-kill-keep"));

	/**
	 * Ceilings by account, as the daemon last reported them.
	 *
	 * Repainted from the `budget` frame rather than re-read: the bump's own
	 * response and the frame carry the same number, and polling for it would
	 * miss a bump made from the CLI while this console was open.
	 * @type {Map<string, number>}
	 */
	const budgets = new Map();

	/** @type {{ name: string, state: string, account?: string, parent?: string }[]} */
	let lastAgents = [];

	/** Which agent the open kill dialog is about; `null` when closed. */
	let killTarget = /** @type {string | null} */ (null);

	/**
	 * Where focus was when the dialog opened, as a T-1615 identity key.
	 *
	 * A key rather than the element itself: the agents panel repaints on
	 * every frame the daemon sends, so the button that opened the dialog is
	 * very likely a *different node* by the time the dialog closes. Holding
	 * the node would restore focus onto something detached, which is a silent
	 * no-op that drops the keyboard back to `<body>`.
	 */
	let killOpenerKey = /** @type {FocusKey | null} */ (null);

	/**
	 * Every agent beneath `name`, transitively, by the parentage the daemon
	 * reports.
	 *
	 * The whole subtree, not just the direct children: the daemon's cascade
	 * walks the tree to its leaves, so a confirmation that named one level
	 * would understate the blast radius of an irreversible operation — the
	 * grandchildren die unannounced. `visited` bounds the walk, because the
	 * console renders whatever edges it is sent and a cycle in them must not
	 * hang the dialog that is supposed to be preventing an accident.
	 * @param {string} name
	 */
	const descendantsOf = (name) => {
		const found = /** @type {string[]} */ ([]);
		const visited = new Set([name]);
		const frontier = [name];
		while (frontier.length > 0) {
			const current = /** @type {string} */ (frontier.pop());
			for (const agent of lastAgents) {
				if (agent.parent !== current || visited.has(agent.name)) continue;
				visited.add(agent.name);
				found.push(agent.name);
				frontier.push(agent.name);
			}
		}
		return found;
	};

	/** @param {unknown} error */
	const showOpsError = (error) => {
		opsErrorEl.textContent =
			error instanceof Error ? error.message : String(error);
	};

	/**
	 * One element inside a cloned row, by class.
	 * @template {HTMLElement} T
	 * @param {DocumentFragment | HTMLElement} root
	 * @param {string} selector
	 * @returns {T}
	 */
	const within = (root, selector) => {
		const node = root.querySelector(selector);
		// The templates in index.html are fixed, so a miss is a broken build,
		// not a runtime condition worth degrading around.
		if (node === null) throw new Error(`Missing ${selector} in template`);
		return /** @type {T} */ (node);
	};

	/**
	 * One agent's operations row: stop, inject, and a logs tail.
	 *
	 * Cloned from the template in index.html rather than assembled here: the
	 * controls are markup, and this only fills in the parts that vary per
	 * agent — the name, the accessible labels, and the handlers.
	 * @param {{ name: string, state: string }} agent
	 */
	const renderOpsAgent = (agent) => {
		const fragment = /** @type {DocumentFragment} */ (
			agentTemplate.content.cloneNode(true)
		);
		const item = within(fragment, ".ops-agent");
		item.dataset.name = agent.name;
		within(fragment, ".ops-name").textContent =
			`${agent.name} (${agent.state})`;

		const kill = within(fragment, ".ops-kill");
		// The name rides in the accessible name: a rail of identical "Stop"
		// buttons tells a screen-reader user nothing about which agent dies.
		kill.setAttribute("aria-label", `Stop ${agent.name}`);
		kill.addEventListener("click", () => {
			openKillDialog(agent.name);
		});

		const logs = within(fragment, ".ops-logs");
		logs.setAttribute("aria-label", `Show recent logs for ${agent.name}`);
		logs.addEventListener("click", () => {
			run(showLogs(agent.name));
		});

		// A <form>, so Enter in the field submits with no pointer and no
		// bespoke keydown handler.
		const injectInput = /** @type {HTMLInputElement} */ (
			within(fragment, ".ops-inject-input")
		);
		injectInput.setAttribute("aria-label", `Message ${agent.name}`);
		within(fragment, ".ops-inject").addEventListener("submit", (event) => {
			event.preventDefault();
			const message = injectInput.value.trim();
			if (message.length === 0) return;
			injectInput.value = "";
			run(injectInto(agent.name, message));
		});

		return item;
	};

	/**
	 * One account's budget row: the ceiling the daemon last reported, and a
	 * field to raise it. Cloned from index.html, like the agent row.
	 * @param {string} account
	 */
	const renderOpsAccount = (account) => {
		const fragment = /** @type {DocumentFragment} */ (
			accountTemplate.content.cloneNode(true)
		);
		const item = within(fragment, ".ops-account");
		item.dataset.account = account;
		within(fragment, ".ops-name").textContent = account;

		const known = budgets.get(account);
		// Absent is said plainly rather than shown as `$0`, which reads as a
		// spent account rather than an unmetered one.
		within(fragment, ".ops-budget").textContent =
			known === undefined ? "no ceiling" : `$${known}`;

		const bumpInput = /** @type {HTMLInputElement} */ (
			within(fragment, ".ops-bump-input")
		);
		bumpInput.setAttribute("aria-label", `New ceiling for ${account}`);
		within(fragment, ".ops-bump").addEventListener("submit", (event) => {
			event.preventDefault();
			const budgetUsd = Number(bumpInput.value);
			if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return;
			bumpInput.value = "";
			run(bumpAccount(account, budgetUsd));
		});

		return item;
	};

	/** @param {{ name: string, state: string, account?: string, parent?: string }[]} agents */
	const renderOps = (agents) => {
		lastAgents = agents;
		const focusKey = captureFocus(opsAgentsEl);
		opsAgentsEl.replaceChildren(...agents.map(renderOpsAgent));
		restoreFocus(opsAgentsEl, focusKey);

		const accounts = [
			...new Set(
				agents
					.map((agent) => agent.account)
					.filter(
						/** @returns {value is string} */
						(value) => typeof value === "string" && value.length > 0,
					),
			),
		].sort();
		const accountKey = captureFocus(opsAccountsEl);
		opsAccountsEl.replaceChildren(...accounts.map(renderOpsAccount));
		restoreFocus(opsAccountsEl, accountKey);
	};

	/**
	 * Open the kill confirmation for one agent.
	 *
	 * Confirmation is required because the operation is irreversible and its
	 * default cascades: the dialog names the children it will take, so the
	 * operator can check the blast radius before it happens rather than read
	 * about it afterwards.
	 * @param {string} name
	 */
	const openKillDialog = (name) => {
		killTarget = name;
		// Captured through the shared helper, so the restore below survives
		// the repaints that happen while the dialog is open (T-1615).
		killOpenerKey = captureFocus(opsAgentsEl);
		// Unchecked every time: the destructive default must not be inherited
		// from whatever the operator chose for a different agent.
		killKeepEl.checked = false;
		// The whole subtree, named, because that is what the default takes:
		// the daemon's cascade walks to the leaves. Checking "keep children"
		// spares every one of these — the direct children are reparented to
		// root and keep their own descendants running — so this list is the
		// blast radius of confirming as-is.
		const doomed = descendantsOf(name);
		killDetailEl.textContent =
			doomed.length === 0
				? `Stop ${name}. It has no children.`
				: `Stop ${name} and everything under it: ${doomed.join(", ")}.`;
		killDialog.showModal();
		// `showModal` focuses the first tabbable node, which is the checkbox
		// that opts out of the cascade — landing the keyboard on the
		// destructive default's escape hatch, not on "Stop".
		killKeepEl.focus();
	};

	/** Close the dialog and hand focus back to the control that opened it. */
	const closeKillDialog = () => {
		killTarget = null;
		if (killDialog.open) killDialog.close();
		const key = killOpenerKey;
		killOpenerKey = null;
		// Through the shared restore, which re-resolves the control by
		// identity: a keyboard operator who dismissed a confirmation must not
		// be dropped to `<body>` and have to tab in from the top again.
		restoreFocus(opsAgentsEl, key);
	};

	/**
	 * Stop an agent, cascading unless the operator opted out.
	 * @param {string} name
	 * @param {boolean} keepChildren
	 */
	const killAgent = async (name, keepChildren) => {
		opsErrorEl.textContent = "";
		try {
			const result = await api(`/api/agents/${encodeURIComponent(name)}/kill`, {
				method: "POST",
				body: { keepChildren },
			});
			// What actually happened, from the daemon: the fallback stops only
			// the named worker, so a console that restated the request would
			// tell an operator a subtree died when one process did.
			noticeEl.textContent = result.cascaded
				? `Stopped ${result.name} and everything under it.`
				: `Stopped ${result.name}. Its children are still running.`;
		} catch (error) {
			showOpsError(error);
		}
		await refreshAgents();
	};

	/**
	 * @param {string} name
	 * @param {string} message
	 */
	const injectInto = async (name, message) => {
		opsErrorEl.textContent = "";
		try {
			const result = await api(
				`/api/agents/${encodeURIComponent(name)}/inject`,
				{ method: "POST", body: { message } },
			);
			// Queued and prompted are different outcomes: a parked peer reads
			// the message on its next turn, and saying "sent" would imply it
			// is being worked on right now.
			noticeEl.textContent = result.queued
				? `Queued for ${result.name}; it reads this when it resumes.`
				: `Sent to ${result.name}.`;
		} catch (error) {
			showOpsError(error);
		}
	};

	/** @param {string} name */
	const showLogs = async (name) => {
		opsErrorEl.textContent = "";
		try {
			const result = await api(`/api/agents/${encodeURIComponent(name)}/logs`);
			const lines = /** @type {string[]} */ (result.lines);
			// Said plainly rather than left blank: an empty <pre> is
			// indistinguishable from a request that never came back.
			opsLogsEl.textContent =
				lines.length === 0 ? `No logs for ${name}.` : lines.join("\n");
		} catch (error) {
			showOpsError(error);
		}
	};

	/**
	 * @param {string} account
	 * @param {number} budgetUsd
	 */
	const bumpAccount = async (account, budgetUsd) => {
		opsErrorEl.textContent = "";
		try {
			const result = await api(
				`/api/accounts/${encodeURIComponent(account)}/bump`,
				{ method: "POST", body: { budgetUsd } },
			);
			noticeEl.textContent =
				result.resumed.length === 0
					? `Raised ${account} to $${result.budgetUsd}.`
					: `Raised ${account} to $${result.budgetUsd}; resumed ${result.resumed.join(", ")}.`;
		} catch (error) {
			showOpsError(error);
		}
	};

	el("ops-kill-cancel").addEventListener("click", () => {
		closeKillDialog();
	});

	// `method="dialog"` closes the dialog for us; this decides whether the
	// close was a confirmation. `returnValue` is the submitter's own value,
	// so Escape and Cancel — which set nothing — cannot kill anything.
	killDialog.addEventListener("close", () => {
		const target = killTarget;
		const confirmed = killDialog.returnValue === "confirm";
		const keepChildren = killKeepEl.checked;
		killDialog.returnValue = "";
		closeKillDialog();
		if (confirmed && target !== null) run(killAgent(target, keepChildren));
	});

	// ── Definition editing (T-1607) ──────────────────────────────────────────

	const definitionDialog = /** @type {HTMLDialogElement} */ (
		el("definition-dialog")
	);
	const definitionHeadingEl = el("definition-heading");
	const definitionPathEl = el("definition-path");
	const definitionChangesEl = /** @type {HTMLTextAreaElement} */ (
		el("definition-changes")
	);
	const definitionErrorEl = el("definition-error");

	/** Which agent the open editor is about; `null` when closed. */
	let definitionTarget = /** @type {string | null} */ (null);

	/**
	 * Where focus was when the editor opened, as a T-1615 identity key.
	 *
	 * A key rather than the node: the agents rail repaints on every frame the
	 * daemon sends, so the button that opened the dialog is very likely a
	 * different element by the time it closes. Restoring the held node would
	 * focus something detached — a silent no-op that drops the keyboard back
	 * to `<body>`.
	 */
	let definitionOpenerKey = /** @type {FocusKey | null} */ (null);

	/**
	 * Load one agent's definition and open the editor on it.
	 *
	 * The document is fetched rather than reconstructed from the agents list:
	 * that list carries only name, state, and rooms, so composing an edit
	 * from it would silently drop every other field the daemon holds.
	 * @param {string} name
	 */
	const openDefinition = async (name) => {
		definitionErrorEl.textContent = "";
		definitionOpenerKey = captureFocus(agentsEl);
		/** @type {any} */
		let loaded;
		try {
			loaded = await api(`/api/agents/${encodeURIComponent(name)}/definition`);
		} catch (error) {
			// Rendered where the operator is looking — beside the agent rail,
			// not inside a dialog that never opened.
			showOpsError(error);
			definitionOpenerKey = null;
			return;
		}
		definitionTarget = name;
		definitionHeadingEl.textContent = `Edit ${name}'s definition`;
		definitionPathEl.textContent = String(loaded.filePath ?? "");
		// `name` is stripped rather than shown: it identifies the file, the
		// PATCH refuses to rename through an edit, and `definition_update`
		// forbids it in `changes` outright. Pre-filling it would present an
		// immutable field as editable — a change the operator makes and the
		// daemon silently ignores, which is exactly the class of lie this
		// editor's strict validation exists to prevent.
		const { name: _immutable, ...editable } = loaded.definition;
		// Pretty-printed: this is a document a human edits by hand, and a
		// single-line JSON blob is not one.
		definitionChangesEl.value = JSON.stringify(editable, null, 2);
		definitionDialog.showModal();
		// `showModal` focuses the first tabbable node; here that is the
		// textarea, which is where the work happens.
		definitionChangesEl.focus();
	};

	/** Close the editor and hand focus back to the control that opened it. */
	const closeDefinitionDialog = () => {
		definitionTarget = null;
		if (definitionDialog.open) definitionDialog.close();
		const key = definitionOpenerKey;
		definitionOpenerKey = null;
		// Through the shared restore, which re-resolves by identity: a
		// keyboard operator who dismissed the editor must not be dropped to
		// `<body>` and have to tab in from the top again.
		restoreFocus(agentsEl, key);
	};

	/**
	 * Save the edited changes document through the definition PATCH.
	 *
	 * Two refusals are possible and both stay in the dialog with the text
	 * intact: malformed JSON, which is caught here, and a document the
	 * daemon's strict parser rejects — an unknown key, a room without its
	 * sigil — whose message is the daemon's own words. Losing an operator's
	 * edit to a validation failure is how editors get hated.
	 * @param {string} name
	 * @param {string} raw
	 */
	const saveDefinition = async (name, raw) => {
		definitionErrorEl.textContent = "";
		/** @type {unknown} */
		let changes;
		try {
			changes = JSON.parse(raw);
		} catch (error) {
			definitionErrorEl.textContent = `Changes must be a JSON object: ${
				error instanceof Error ? error.message : String(error)
			}`;
			return false;
		}
		if (
			typeof changes !== "object" ||
			changes === null ||
			Array.isArray(changes)
		) {
			definitionErrorEl.textContent = "Changes must be a JSON object.";
			return false;
		}

		/** @type {any} */
		let result;
		try {
			result = await api(`/api/agents/${encodeURIComponent(name)}`, {
				method: "PATCH",
				body: changes,
			});
		} catch (error) {
			definitionErrorEl.textContent =
				error instanceof Error ? error.message : String(error);
			return false;
		}
		// The daemon's own words about what took effect: a policy edit waits
		// for the next turn's rebuild, a rooms-only edit is already live.
		noticeEl.textContent =
			typeof result.notice === "string" ? result.notice : "";
		await refreshAgents();
		return true;
	};

	el("definition-cancel").addEventListener("click", () => {
		closeDefinitionDialog();
	});

	// The form is `method="dialog"`, so an unprevented submit would close the
	// dialog before the save resolves — and a refused edit has to keep the
	// operator's text, and the parser's message, on screen. The default is
	// prevented here and the dialog closes only once the daemon accepted it.
	el("definition-form").addEventListener("submit", (event) => {
		event.preventDefault();
		const name = definitionTarget;
		if (name === null) return;
		run(
			saveDefinition(name, definitionChangesEl.value).then((saved) => {
				if (saved) closeDefinitionDialog();
			}),
		);
	});

	// Escape closes a <dialog> natively; this returns focus to the opener on
	// that path too, rather than leaving the keyboard wherever the browser
	// dropped it when the modal went away.
	definitionDialog.addEventListener("close", () => {
		if (definitionTarget !== null) closeDefinitionDialog();
	});

	// ── First-class states ───────────────────────────────────────────────────

	const stateTitleEl = /** @type {HTMLElement} */ (
		stateEl.querySelector(".state-title")
	);
	const stateDetailEl = /** @type {HTMLElement} */ (
		stateEl.querySelector(".state-detail")
	);
	const stateActionEl = /** @type {HTMLButtonElement} */ (
		stateEl.querySelector(".state-action")
	);

	/** @type {(() => void) | null} What the state's one action does now. */
	let stateAction = null;

	/**
	 * Show one first-class state screen. The screen lives in index.html; this
	 * only fills it in, so the markup contract stays in one file.
	 * @param {"connecting" | "offline" | "load-failure" | "empty"} state
	 * @param {string} title
	 * @param {string} detail
	 * @param {string} actionLabel empty string means no action.
	 * @param {(() => void) | null} action
	 */
	const showState = (state, title, detail, actionLabel, action) => {
		stateEl.dataset.state = state;
		stateTitleEl.textContent = title;
		stateDetailEl.textContent = detail;
		stateActionEl.textContent = actionLabel;
		stateActionEl.hidden = actionLabel.length === 0;
		stateAction = action;
		stateEl.hidden = false;
		// Whole-console outage: the retry affordance is the only next step,
		// so a keyboard user starts on it instead of hunting for it.
		if (state === "offline" && actionLabel.length > 0) {
			stateActionEl.focus();
		}
	};

	const clearState = () => {
		stateEl.hidden = true;
		stateAction = null;
	};

	stateActionEl.addEventListener("click", () => {
		if (stateAction !== null) stateAction();
	});

	// ── State ────────────────────────────────────────────────────────────────

	let refreshRequest = 0;

	/** Refetch the open room and repaint transcript + thread pane. */
	const refresh = async () => {
		if (currentRoom === null) return;
		const room = currentRoom;
		const request = ++refreshRequest;
		/** @type {any} */
		let payload;
		try {
			payload = await api(`/api/channels/${encodeURIComponent(room)}/messages`);
		} catch (error) {
			if (request !== refreshRequest || room !== currentRoom) return;
			showState(
				"load-failure",
				"Transcript failed to load",
				error instanceof Error ? error.message : String(error),
				"Retry",
				() => run(refresh()),
			);
			return;
		}
		const messages = /** @type {RoomMessage[]} */ (payload.messages);
		if (request !== refreshRequest || room !== currentRoom) return;
		lastSeen.set(room, messages.at(-1)?.id ?? 0);
		renderTranscript(messages);
		renderThread(messages);
		if (messages.length === 0) {
			showState(
				"empty",
				`${room} is quiet`,
				"Nothing has been said here yet.",
				"Write the first message",
				() => composerInput.focus(),
			);
		} else {
			clearState();
		}
	};

	/**
	 * Refetch the agent list, so membership and the operations panel both
	 * render from one read rather than two racing ones.
	 */
	const refreshAgents = async () => {
		const { agents } = await api("/api/agents");
		const list =
			/** @type {{ name: string, state: string, account?: string, parent?: string, rooms?: string[] }[]} */ (
				agents
			);
		renderAgents(list);
		renderOps(list);
	};

	/** Refetch the channel list. */
	const refreshChannels = async () => {
		const { channels } = await api("/api/channels");
		lastChannels = /** @type {RoomInfo[]} */ (channels);
		renderChannels(lastChannels);
	};

	/** The stale-unread words this console last wrote, so it retracts exactly
	 * those and never a notice somebody else put there. @type {string} */
	let staleNotice = "";

	/** Rooms read at once by one reconcile pass. A console can carry many
	 * channels and the pass runs on every socket open, so the reads are
	 * pooled rather than fired as one burst per room. */
	const RECONCILE_CONCURRENCY = 4;

	/** The pass now running, so a flapping socket cannot stack them.
	 * @type {Promise<void> | null} */
	let reconcilePass = null;
	/** A socket opened while a pass was running. That pass read the store
	 * before this open, so it may predate what this open owes: exactly one
	 * more pass is queued, and further opens collapse into that same one. */
	let reconcileQueued = false;

	/**
	 * Heal unread state from room transcripts after missed socket frames.
	 *
	 * Only rooms the operator has actually opened are read. A room with no
	 * cursor has never been seen, so everything in it is history rather than
	 * something missed while deaf — marking those would badge the whole
	 * sidebar on the first socket open of every session, and would pay one
	 * request per room to do it.
	 *
	 * A read that fails is caught per room rather than at the join. Settling
	 * the join and reading nothing back would swallow the failure whole: the
	 * rooms that did answer must still be marked, the socket-open handler
	 * must not be handed a rejection, and a room left unknown must not pass
	 * for read. So a failure marks nothing in either direction — the mark the
	 * room already carries stands — names the room to the operator, and is
	 * retried by the next socket open, which is the only thing that fetches
	 * a background room at all.
	 */
	const reconcileOnce = async () => {
		const rooms = lastChannels.filter(
			(channel) =>
				channel.id !== currentRoom && (lastSeen.get(channel.id) ?? 0) > 0,
		);
		/** @type {string[]} */
		const stale = [];
		let next = 0;
		const worker = async () => {
			while (next < rooms.length) {
				const channel = rooms[next];
				next += 1;
				// Re-read the cursor this room is actually at: the operator can
				// visit a room mid-pass, which both moves its cursor and makes
				// it the open room.
				const seen = lastSeen.get(channel.id) ?? 0;
				if (channel.id === currentRoom || seen === 0) continue;
				// Total: anything thrown in here — the read, the payload's
				// shape — is this room's failure alone. An escaping throw would
				// reject the join and skip both the repaint and the notice
				// while other rooms' marks were already committed.
				try {
					const payload = await api(
						`/api/channels/${encodeURIComponent(channel.id)}/messages?afterId=${seen}&limit=1`,
						// Names what this read is for, so a proxy or a log can
						// tell reconciliation from a transcript load without
						// pattern-matching a query string any later caller
						// could collide with.
						{ headers: { "X-Reconcile": "1" } },
					);
					const activity = /** @type {RoomMessage[]} */ (payload.messages)[0];
					const currentSeen = lastSeen.get(channel.id) ?? 0;
					if (
						channel.id === currentRoom ||
						currentSeen === 0 ||
						activity === undefined ||
						activity.id <= currentSeen
					) {
						continue;
					}
					unreadRooms.add(channel.id);
				} catch {
					stale.push(channel.id);
				}
			}
		};
		try {
			await Promise.all(
				Array.from(
					{ length: Math.min(RECONCILE_CONCURRENCY, rooms.length) },
					() => worker(),
				),
			);
		} finally {
			renderChannels(lastChannels);
			if (stale.length > 0) {
				// Written only over silence or over this console's own stale
				// words. Every other notice answers something the operator just
				// did, and a background pass must not wipe it. `staleNotice` is
				// set only on the write that lands, so a later retraction can
				// never erase text this console does not own.
				if (
					noticeEl.textContent === "" ||
					noticeEl.textContent === staleNotice
				) {
					staleNotice = `Unread state is stale for ${stale.join(", ")}; retrying on the next reconnect.`;
					noticeEl.textContent = staleNotice;
				}
			} else if (staleNotice !== "" && noticeEl.textContent === staleNotice) {
				noticeEl.textContent = "";
				staleNotice = "";
			}
			window.__consoleReconcilePasses += 1;
		}
	};

	/**
	 * Run a reconcile pass, coalescing socket opens that arrive during one.
	 *
	 * A flapping socket must not stack passes: a running pass may have read
	 * the store before this open, so exactly one more pass is queued behind
	 * it and every further open collapses into that same one.
	 */
	const reconcileUnread = async () => {
		if (reconcilePass !== null) {
			reconcileQueued = true;
			return reconcilePass;
		}
		reconcilePass = (async () => {
			try {
				await reconcileOnce();
				while (reconcileQueued) {
					reconcileQueued = false;
					await reconcileOnce();
				}
			} finally {
				reconcilePass = null;
				reconcileQueued = false;
			}
		})();
		return reconcilePass;
	};

	/** @param {string} room */
	const selectRoom = async (room) => {
		currentRoom = room;
		unreadRooms.delete(room);
		renderChannels(lastChannels);
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
		threadTitleEl.textContent = "Thread";
		// Paint before unhiding: the pane's visibility is the signal that the
		// thread is ready, so revealing an empty list first is a lie.
		await refresh();
		threadEl.hidden = false;
		// Focus follows the view change; Escape or Close hands it back.
		el("thread-close").focus();
	};

	/** Close the pane and return focus to the opener that revealed it. */
	const closeThread = () => {
		const rootId = openThreadRoot;
		openThreadRoot = null;
		threadEl.hidden = true;
		if (rootId === null) return;
		// The opener is re-rendered on every refresh, so it is found by id
		// now, not held from open time.
		/** @type {HTMLElement | null} */
		const opener = messagesEl.querySelector(
			`.message[data-id="${rootId}"] .thread-open`,
		);
		opener?.focus();
	};

	/**
	 * Toggle the operator's own reaction through the daemon's reaction route.
	 *
	 * No refetch afterwards: the write's own change comes back as a reaction
	 * frame like anyone else's, and applying it twice — once from a refetch,
	 * once from the frame — counts the same actor twice. The socket-open
	 * refetch remains the healing path if a frame is missed (ADR-015).
	 * @param {number} messageId
	 * @param {string} emoji
	 */
	const toggleReaction = async (messageId, emoji) => {
		await api(`/api/messages/${messageId}/reactions/toggle`, {
			method: "POST",
			body: { actor: HUMAN_AUTHOR, emoji },
		});
	};

	/**
	 * Send one message, as a root or into an open thread.
	 *
	 * A refused post renders the daemon's own words in the notice: the
	 * composer has already been cleared by the time this runs, so swallowing
	 * the error would lose the operator's text with no explanation of where
	 * it went.
	 * @param {string} body
	 * @param {number | null} parentId
	 */
	const postMessage = async (body, parentId) => {
		if (currentRoom === null) return;
		noticeEl.textContent = "";
		try {
			await api(`/api/channels/${encodeURIComponent(currentRoom)}/messages`, {
				method: "POST",
				body: { body, author: HUMAN_AUTHOR, parentId },
			});
		} catch (error) {
			noticeEl.textContent =
				error instanceof Error ? error.message : String(error);
			return;
		}
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

	/**
	 * Enter sends, Shift+Enter breaks the line — the hint under each composer
	 * promises exactly this, so both textareas share one handler.
	 * @param {HTMLFormElement} form
	 * @returns {(event: KeyboardEvent) => void}
	 */
	const sendOnEnter = (form) => (event) => {
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		form.requestSubmit();
	};

	composerInput.addEventListener(
		"keydown",
		sendOnEnter(/** @type {HTMLFormElement} */ (composerEl)),
	);
	threadComposerInput.addEventListener(
		"keydown",
		sendOnEnter(/** @type {HTMLFormElement} */ (threadComposerEl)),
	);

	composerEl.addEventListener("submit", (event) => {
		event.preventDefault();
		const body = composerInput.value.trim();
		if (body.length === 0) return;
		composerInput.value = "";
		run(postMessage(body, null));
	});

	threadComposerEl.addEventListener("submit", (event) => {
		event.preventDefault();
		const body = threadComposerInput.value.trim();
		if (body.length === 0 || openThreadRoot === null) return;
		threadComposerInput.value = "";
		run(postMessage(body, openThreadRoot));
	});

	el("thread-close").addEventListener("click", () => {
		closeThread();
	});

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || threadEl.hidden) return;
		event.preventDefault();
		closeThread();
	});

	// The transcript log is keyboard-scrollable wherever it has focus; the
	// handler is explicit so behavior does not depend on UA scroll quirks.
	messagesEl.addEventListener("keydown", (event) => {
		/** @type {Record<string, number>} */
		const deltas = {
			ArrowDown: 48,
			ArrowUp: -48,
			PageDown: messagesEl.clientHeight,
			PageUp: -messagesEl.clientHeight,
			End: messagesEl.scrollHeight,
			Home: -messagesEl.scrollHeight,
		};
		const delta = deltas[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		messagesEl.scrollTop += delta;
	});

	newChannelForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const id = newChannelInput.value.trim();
		if (id.length === 0) return;
		newChannelInput.value = "";
		run(createChannel(id));
	});

	newAgentForm.addEventListener("submit", (event) => {
		event.preventDefault();
		run(createAgent());
	});

	/**
	 * Apply one reaction frame to the open transcript in place.
	 *
	 * In place rather than `refresh()`: a refetch rebuilds every row, which
	 * throws away scroll, focus, and the thread pane's contents for a change
	 * to one chip — and it races the poll feed that delivered the frame. The
	 * socket-open refetch stays as the healing path for anything missed while
	 * the socket was down (ADR-015).
	 *
	 * A frame for a message this console is not showing is dropped: the row
	 * may be in a collapsed thread or below the transcript's window, and both
	 * paint from the store the next time they render.
	 * @param {{ messageId: number, actor: string, emoji: string, reacted: boolean }} frame
	 */
	const applyReaction = (frame) => {
		const selector = `.message[data-id="${CSS.escape(String(frame.messageId))}"]`;
		for (const container of [messagesEl, threadMessagesEl]) {
			const row = container.querySelector(selector);
			if (row === null) continue;
			const chips = row.querySelector(".reactions");
			if (chips === null) continue;
			/** @type {HTMLElement | null} */
			const chip = chips.querySelector(
				`.reaction[data-emoji="${CSS.escape(frame.emoji)}"]`,
			);

			// Applied as a set operation over the chip's actors, never as a
			// ±1 on its count: the socket-open refetch paints authoritative
			// state, and a frame for a reaction that snapshot already showed
			// would otherwise count the same actor twice.
			const actors = chip === null ? [] : chipActors(chip);
			const next = frame.reacted
				? actors.includes(frame.actor)
					? actors
					: [...actors, frame.actor]
				: actors.filter((actor) => actor !== frame.actor);

			if (next.length === 0) {
				chip?.remove();
				continue;
			}
			if (chip === null) {
				chips.append(renderChip(frame.messageId, frame.emoji, next));
				continue;
			}
			// Repaint the existing node rather than replacing it: a
			// replacement is a different element, so the operator's focus —
			// and the click handler bound to it — would be destroyed by
			// somebody else's reaction landing.
			paintChip(chip, frame.emoji, next);
		}
	};

	// ── Live feed with reconnect ─────────────────────────────────────────────

	// Exposed for tests: a harness can sever the socket in-page.
	const sockets = /** @type {WebSocket[]} */ ([]);
	window.__consoleSockets = sockets;
	window.__consoleReconcilePasses = 0;

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
			// Refetch on open, not before it: activity landing between the close
			// and the new socket's open is missed by a pre-connect refetch.
			run(refresh());
			run(reconcileUnread());
		});

		socket.addEventListener("message", (event) => {
			/** @type {ConsoleEvent} */
			let frame;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			// Each type drives exactly one refresher, never the transcript: a
			// panel-level change must not rebuild the message list, which
			// costs the reader their scroll position and focus. An unknown
			// type falls through and is ignored — this shell may be a cached
			// build older than the daemon's frame taxonomy, and a console that
			// threw on a new type would break on every daemon upgrade.
			if (frame.type === "message") {
				if (frame.message.room === currentRoom) {
					run(refresh());
				} else {
					// Activity somewhere the operator is not looking: mark it
					// until the room is visited.
					unreadRooms.add(frame.message.room);
					renderChannels(lastChannels);
				}
			} else if (frame.type === "reaction" && frame.room === currentRoom) {
				applyReaction(frame);
			} else if (
				frame.type === "agent" ||
				frame.type === "definition" ||
				frame.type === "membership" ||
				frame.type === "budget" ||
				frame.type === "schedule"
			) {
				// A budget frame carries the ceiling itself, so it is applied
				// before the refetch rather than read back from one: the bump
				// route answers no ceiling on `/api/agents`, and a console
				// that polled for it would also miss a bump made from the CLI
				// while this page was open (ADR-015).
				if (frame.type === "budget" && frame.budgetUsd !== undefined) {
					budgets.set(frame.account, frame.budgetUsd);
					renderOps(lastAgents);
				}
				// All five render in the agents panel: run state, the rebuild
				// a definition owes, membership for the open channel, and the
				// account state a peer is parked by.
				run(refreshAgents());
			} else if (frame.type === "channel") {
				run(refreshChannels());
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
		// Connecting until the first fetch resolves; offline when it cannot.
		// Both are the whole-console states — a per-room failure is the
		// transcript's own load-failure screen, not this one.
		showState("connecting", "Connecting…", "Reaching the daemon.", "", null);
		/** @type {any} */
		let payload;
		try {
			payload = await api("/api/channels");
		} catch (error) {
			showState(
				"offline",
				"Daemon offline",
				error instanceof Error ? error.message : String(error),
				"Retry",
				() => run(boot()),
			);
			return;
		}
		clearState();
		const channels = /** @type {RoomInfo[]} */ (payload.channels);
		lastChannels = channels;
		renderChannels(channels);
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

	run(boot());
})();
