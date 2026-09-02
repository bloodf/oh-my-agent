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
			void toggleReaction(messageId, emoji);
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
				void openThread(message.id);
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
				void selectRoom(channel.id);
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

	/** Refetch the open room and repaint transcript + thread pane. */
	const refresh = async () => {
		if (currentRoom === null) return;
		/** @type {any} */
		let payload;
		try {
			payload = await api(
				`/api/channels/${encodeURIComponent(currentRoom)}/messages`,
			);
		} catch (error) {
			showState(
				"load-failure",
				"Transcript failed to load",
				error instanceof Error ? error.message : String(error),
				"Retry",
				() => void refresh(),
			);
			return;
		}
		const messages = /** @type {RoomMessage[]} */ (payload.messages);
		renderTranscript(messages);
		renderThread(messages);
		if (messages.length === 0) {
			showState(
				"empty",
				`${currentRoom} is quiet`,
				"Nothing has been said here yet.",
				"Write the first message",
				() => composerInput.focus(),
			);
		} else {
			clearState();
		}
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
		lastChannels = /** @type {RoomInfo[]} */ (channels);
		renderChannels(lastChannels);
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
		void createChannel(id);
	});

	newAgentForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void createAgent();
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
			// Each type drives exactly one refresher, never the transcript: a
			// panel-level change must not rebuild the message list, which
			// costs the reader their scroll position and focus. An unknown
			// type falls through and is ignored — this shell may be a cached
			// build older than the daemon's frame taxonomy, and a console that
			// threw on a new type would break on every daemon upgrade.
			if (frame.type === "message") {
				if (frame.message.room === currentRoom) {
					void refresh();
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
				// All five render in the agents panel: run state, the rebuild
				// a definition owes, membership for the open channel, and the
				// account state a peer is parked by.
				void refreshAgents();
			} else if (frame.type === "channel") {
				void refreshChannels();
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
				() => void boot(),
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

	void boot();
})();
