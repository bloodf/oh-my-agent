/**
 * Fixture catalog for the real console CSS. No framework.
 * Each story is HTML that production style.css paints.
 */

function channel(id, label, extra = "") {
	const selected = extra.includes("active") ? "true" : "false";
	return `<li role="presentation"><button type="button" role="option" class="channel${extra}" data-id="${id}" aria-selected="${selected}">${label}</button></li>`;
}

function message(opts) {
	const grouped = opts.grouped ? " grouped" : "";
	const mention = opts.mention
		? `<span class="mention">@${opts.mention}</span>`
		: "";
	const reactions = opts.reactions
		? `<span class="reactions">${opts.reactions
				.map(
					(r) =>
						`<button type="button" class="reaction${r.mine ? " mine" : ""}">${r.emoji} ${r.count}</button>`,
				)
				.join("")}</span>`
		: "";
	const thread = opts.thread
		? `<button type="button" class="thread-open">${opts.thread} replies</button>`
		: "";
	const meta = opts.grouped
		? ""
		: `<div class="meta"><span class="author">${opts.author}</span><span class="timestamp">${opts.time}</span>${reactions}${thread}</div>`;
	const body = opts.code
		? `<pre>${opts.body}</pre>`
		: `<p class="body">${opts.body}${mention}</p>`;
	return `<article class="message role-${opts.role}${grouped}">${meta}${body}</article>`;
}

const SIDEBAR = `
<nav id="sidebar" aria-label="Channels and agents">
	<h1>Channels</h1>
	<ul id="channels" role="listbox" aria-label="Channels">
		${channel("#research", "#research", " active")}
		${channel("#ops", "#ops", " unread")}
		${channel("@reviewer", "@reviewer", "")}
	</ul>
	<form id="new-channel">
		<input id="new-channel-input" type="text" placeholder="#new-channel" />
		<button id="new-channel-create" type="submit">Create</button>
	</form>
	<p id="new-channel-error"></p>
	<h1>Agents</h1>
	<ul id="agents">
		<li class="agent" data-name="researcher">
			<span class="agent-name">researcher (running)</span>
			<button type="button" class="membership-toggle member" data-member="true">Leave</button>
			<button type="button" class="definition-edit" aria-label="Edit researcher's definition">Edit</button>
		</li>
		<li class="agent" data-name="reviewer">
			<span class="agent-name">reviewer (parked)</span>
			<button type="button" class="membership-toggle" data-member="false">Join</button>
			<button type="button" class="definition-edit" aria-label="Edit reviewer's definition">Edit</button>
		</li>
	</ul>
	<h1>New agent</h1>
	<form id="new-agent">
		<input id="new-agent-name" type="text" placeholder="name" />
		<input id="new-agent-description" type="text" placeholder="description" />
		<input id="new-agent-spawns" type="text" placeholder="spawns (comma separated)" />
		<input id="new-agent-rooms" type="text" placeholder="rooms (comma separated)" />
		<textarea id="new-agent-body" placeholder="system prompt"></textarea>
		<button id="new-agent-create" type="submit">Create agent</button>
	</form>
	<p id="new-agent-error"></p>
</nav>`;

const OPS = `
<section id="ops" aria-label="Operations">
	<h1>Operations</h1>
	<ul id="ops-agents">
		<li class="ops-agent">
			<span class="ops-name">researcher</span>
			<button type="button" class="ops-kill">Stop</button>
			<button type="button" class="ops-logs">Logs</button>
			<form class="ops-inject"><input class="ops-inject-input" type="text" placeholder="Message this agent" /></form>
		</li>
		<li class="ops-agent">
			<span class="ops-name">reviewer</span>
			<button type="button" class="ops-kill">Stop</button>
			<button type="button" class="ops-logs">Logs</button>
			<form class="ops-inject"><input class="ops-inject-input" type="text" placeholder="Message this agent" /></form>
		</li>
	</ul>
	<h2>Accounts</h2>
	<ul id="ops-accounts">
		<li class="ops-account">
			<span class="ops-name">anthropic</span>
			<span class="ops-budget">$1.20 / $5.00</span>
			<form class="ops-bump"><input class="ops-bump-input" type="number" placeholder="New ceiling" /></form>
		</li>
	</ul>
	<p id="ops-error"></p>
	<h2 id="ops-logs-title">Logs</h2>
	<pre id="ops-logs-output" role="log">researcher ready
subscribed #research</pre>
</section>`;

const TRANSCRIPT = `
${message({ role: "agent", author: "researcher", time: "23:47", body: "Paper 2314 fails on reproducibility. Flagging section 4.2." })}
${message({ role: "you", author: "you", time: "23:48", body: "Approve ablation. Keep it under 3 min.", mention: "researcher" })}
${message({
	role: "agent",
	author: "reviewer",
	time: "23:49",
	body: "Queued on node-07.",
	reactions: [
		{ emoji: "✅", count: 1, mine: true },
		{ emoji: "👀", count: 2, mine: false },
	],
	thread: 3,
})}
${message({ role: "agent", author: "reviewer", time: "23:49", body: "Follow-up: citation lands in #research.", grouped: true })}
`;

const COMPOSER = `
<form id="composer">
	<textarea id="composer-input" rows="1" aria-label="Message the channel" placeholder="Message the channel"></textarea>
	<button id="composer-send" type="submit">Send</button>
	<p class="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</p>
</form>`;

const THREAD = `
<aside id="thread" role="complementary" aria-label="Thread">
	<header>
		<span id="thread-title">Thread on reviewer</span>
		<button id="thread-close" type="button" aria-label="Close thread">Close</button>
	</header>
	<div id="thread-messages">
		${message({ role: "agent", author: "reviewer", time: "23:49", body: "Queued on node-07." })}
		${message({ role: "you", author: "you", time: "23:50", body: "Ship it if the ablation is green." })}
	</div>
	<form id="thread-composer">
		<textarea id="thread-composer-input" rows="1" aria-label="Reply in thread" placeholder="Reply in thread"></textarea>
		<button id="thread-composer-send" type="submit">Reply</button>
		<p class="composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</p>
	</form>
</aside>`;

const MAIN = `
<main id="main">
	<p id="notice" role="status"></p>
	<header id="current-channel" role="banner">#research</header>
	<div id="messages" role="log" aria-label="Channel transcript" tabindex="0">${TRANSCRIPT}</div>
	<div id="state" role="status" hidden>
		<p class="state-title"></p>
		<p class="state-detail"></p>
		<button class="state-action" type="button"></button>
	</div>
	${COMPOSER}
</main>`;

export const STORIES = [
	{
		id: "page-populated",
		group: "Pages",
		title: "Console — populated",
		docs: "Four panes: channels + create forms, operations, transcript, thread. This is the live operator surface.",
		layout: "fullscreen",
		html: `<a class="skip-link" href="#composer-input">Skip to composer</a>${SIDEBAR}${OPS}${MAIN}${THREAD}`,
	},
	{
		id: "page-empty",
		group: "Pages",
		title: "Console — empty",
		docs: "No rooms yet. Create-channel form is the first action.",
		layout: "fullscreen",
		html: `<nav id="sidebar" aria-label="Channels and agents">
			<h1>Channels</h1>
			<ul id="channels" role="listbox" aria-label="Channels"></ul>
			<form id="new-channel">
				<input id="new-channel-input" type="text" placeholder="#new-channel" />
				<button type="submit">Create</button>
			</form>
			<h1>Agents</h1>
			<ul id="agents"></ul>
		</nav>
		<section id="ops" aria-label="Operations"><h1>Operations</h1><ul id="ops-agents"></ul></section>
		<main id="main">
			<header id="current-channel" role="banner">No channel selected</header>
			<div id="messages" role="log"></div>
			<div id="state" data-state="empty">
				<p class="state-title">No messages yet</p>
				<p class="state-detail">Create a channel, then post as @you.</p>
			</div>
			${COMPOSER}
		</main>`,
	},
	{
		id: "page-offline",
		group: "Pages",
		title: "Console — offline",
		docs: "WebSocket dropped. Retry is first-class, not a blank pane.",
		layout: "fullscreen",
		html: `${SIDEBAR}${OPS}
		<main id="main">
			<header id="current-channel" role="banner">#research</header>
			<div id="messages" role="log"></div>
			<div id="state" data-state="offline">
				<p class="state-title">Disconnected</p>
				<p class="state-detail">The live feed dropped. Transcript is stale until reconnect.</p>
				<button class="state-action" type="button">Retry</button>
			</div>
			${COMPOSER}
		</main>`,
	},
	{
		id: "page-load-failure",
		group: "Pages",
		title: "Console — load failure",
		docs: "Initial fetch failed. Same state chrome as offline, different copy.",
		layout: "fullscreen",
		html: `${SIDEBAR}${OPS}
		<main id="main">
			<header id="current-channel" role="banner">#research</header>
			<div id="messages" role="log"></div>
			<div id="state" data-state="load-failure">
				<p class="state-title">Could not load</p>
				<p class="state-detail">The daemon refused or the network failed.</p>
				<button class="state-action" type="button">Retry</button>
			</div>
			${COMPOSER}
		</main>`,
	},
	{
		id: "page-auth",
		group: "Pages",
		title: "Operator auth — first visit",
		docs: "Remote mode only. Loopback skips this and uses ?token= on the first navigation.",
		layout: "fullscreen",
		html: `<section id="operator-auth" aria-labelledby="operator-auth-title">
			<h1 id="operator-auth-title">Operator authentication</h1>
			<p>Enter the operator token to open this remote console.</p>
			<form id="operator-auth-form">
				<label for="operator-token">Operator token</label>
				<input id="operator-token" type="password" autocomplete="off" required />
				<button type="submit">Open console</button>
				<p id="operator-auth-error" role="alert"></p>
			</form>
		</section>`,
	},
	{
		id: "page-auth-refused",
		group: "Pages",
		title: "Operator auth — refused",
		docs: "Bad or rotated token. Re-entry keeps the field focused.",
		layout: "fullscreen",
		html: `<section id="operator-auth" aria-labelledby="operator-auth-title">
			<h1 id="operator-auth-title">Operator authentication</h1>
			<p>Enter the operator token to open this remote console.</p>
			<form id="operator-auth-form">
				<label for="operator-token">Operator token</label>
				<input id="operator-token" type="password" autocomplete="off" required />
				<button type="submit">Open console</button>
				<p id="operator-auth-error" role="alert">Operator token refused. Re-enter the token.</p>
			</form>
		</section>`,
	},
	{
		id: "comp-channels",
		group: "Components",
		title: "Channel list",
		docs: "Active, unread dot, DM. Unread is a marker, not a count.",
		layout: "padded",
		html: `<nav id="sidebar" style="height: auto; width: 15rem;">
			<h1>Channels</h1>
			<ul id="channels" role="listbox">
				${channel("#research", "#research", " active")}
				${channel("#ops", "#ops", " unread")}
				${channel("#reviews", "#reviews", "")}
				${channel("@you", "@you", "")}
			</ul>
		</nav>`,
	},
	{
		id: "comp-messages",
		group: "Components",
		title: "Messages",
		docs: "Roles (agent / you / system), grouped follow-up, mention chip, fenced body, reactions, thread opener.",
		layout: "padded",
		html: `<div id="messages" style="height: auto; overflow: visible;">
			${message({ role: "system", author: "system", time: "23:40", body: "researcher joined #research" })}
			${message({ role: "agent", author: "researcher", time: "23:47", body: "Looked up spawn vs task." })}
			${message({ role: "agent", author: "researcher", time: "23:47", body: "const worker = spawn(def);", code: true, grouped: true })}
			${message({ role: "you", author: "you", time: "23:48", body: "Ship the note.", mention: "researcher" })}
			${message({
				role: "agent",
				author: "reviewer",
				time: "23:49",
				body: "Ablation queued.",
				reactions: [{ emoji: "✅", count: 1, mine: true }],
				thread: 2,
			})}
		</div>`,
	},
	{
		id: "comp-composer",
		group: "Components",
		title: "Composer",
		docs: "Enter sends. Shift+Enter newline. Same chrome on the thread composer.",
		layout: "padded",
		html: `<div style="width: min(40rem, 100%);">${COMPOSER}</div>`,
	},
	{
		id: "comp-thread",
		group: "Components",
		title: "Thread pane",
		docs: "Side pane, not inline. Channel root stays in view.",
		layout: "padded",
		html: `<div style="height: 28rem; display: flex;">${THREAD}</div>`,
	},
	{
		id: "comp-agents",
		group: "Components",
		title: "Agent rail",
		docs: "Membership toggle for the open channel plus Edit definition.",
		layout: "padded",
		html: `<nav id="sidebar" style="height: auto; width: 17rem;">
			<h1>Agents</h1>
			<ul id="agents">
				<li class="agent"><span class="agent-name">researcher (running)</span>
					<button type="button" class="membership-toggle member">Leave</button>
					<button type="button" class="definition-edit">Edit</button></li>
				<li class="agent"><span class="agent-name">scout (stopped)</span>
					<button type="button" class="membership-toggle">Join</button>
					<button type="button" class="definition-edit">Edit</button></li>
			</ul>
		</nav>`,
	},
	{
		id: "comp-ops",
		group: "Components",
		title: "Operations panel",
		docs: "Stop, logs, inject, budget bump. Kill is labeled destructive on hover.",
		layout: "padded",
		html: `<div style="height: 32rem; display: flex;">${OPS}</div>`,
	},
	{
		id: "comp-kill-dialog",
		group: "Components",
		title: "Stop-agent dialog",
		docs: "Native &lt;dialog&gt;. Children are named. Default is cascade.",
		layout: "dialog",
		html: `<dialog id="ops-kill-dialog" open aria-labelledby="ops-kill-heading">
			<form method="dialog" id="ops-kill-form">
				<h2 id="ops-kill-heading">Stop an agent</h2>
				<p id="ops-kill-detail">Stop researcher and children scout, writer.</p>
				<label id="ops-kill-keep-label" for="ops-kill-keep">
					<input type="checkbox" id="ops-kill-keep" />
					Keep children running (reparent them to root)
				</label>
				<div class="ops-dialog-actions">
					<button type="submit" id="ops-kill-confirm" value="confirm">Stop</button>
					<button type="button" id="ops-kill-cancel">Cancel</button>
				</div>
			</form>
		</dialog>`,
	},
	{
		id: "comp-definition-dialog",
		group: "Components",
		title: "Definition editor",
		docs: "JSON changes object, same shape as definition_update.",
		layout: "dialog",
		html: `<dialog id="definition-dialog" open aria-labelledby="definition-heading">
			<form method="dialog" id="definition-form">
				<h2 id="definition-heading">Edit definition</h2>
				<p id="definition-path">.omp/oh-my-agent/agents/researcher.md</p>
				<label id="definition-changes-label" for="definition-changes">Changes, as a JSON object</label>
				<textarea id="definition-changes" rows="10">{
  "description": "Investigates technical questions.",
  "rooms": ["#research"]
}</textarea>
				<p id="definition-error" role="status"></p>
				<div class="definition-actions">
					<button type="submit" id="definition-save" value="save">Save</button>
					<button type="button" id="definition-cancel">Cancel</button>
				</div>
			</form>
		</dialog>`,
	},
	{
		id: "comp-definition-error",
		group: "Components",
		title: "Definition editor — refusal",
		docs: "Parser refusal stays on the dialog. Draft is not discarded.",
		layout: "dialog",
		html: `<dialog id="definition-dialog" open aria-labelledby="definition-heading">
			<form method="dialog">
				<h2 id="definition-heading">Edit definition</h2>
				<p id="definition-path">.omp/oh-my-agent/agents/researcher.md</p>
				<label id="definition-changes-label" for="definition-changes">Changes, as a JSON object</label>
				<textarea id="definition-changes" rows="8">{ "tools": ["bash"] }</textarea>
				<p id="definition-error" role="status">unknown key tools — agent create accepts the definition subset only</p>
				<div class="definition-actions">
					<button type="submit" id="definition-save">Save</button>
					<button type="button" id="definition-cancel">Cancel</button>
				</div>
			</form>
		</dialog>`,
	},
	{
		id: "comp-new-agent",
		group: "Components",
		title: "Create-agent form",
		docs: "Parser-validated. Error renders beside the form.",
		layout: "padded",
		html: `<nav id="sidebar" style="height: auto; width: 17rem;">
			<h1>New agent</h1>
			<form id="new-agent">
				<input value="researcher" />
				<input value="Investigates technical questions" />
				<input value="scout" />
				<input value="#research" />
				<textarea>Investigate requests from #research.</textarea>
				<button type="submit">Create agent</button>
			</form>
			<p id="new-agent-error">name already exists</p>
		</nav>`,
	},
	{
		id: "state-empty",
		group: "States",
		title: "Empty transcript",
		docs: "First-class empty, not a blank log.",
		layout: "padded",
		html: `<div id="state" data-state="empty">
			<p class="state-title">No messages yet</p>
			<p class="state-detail">Create a channel, then post as @you.</p>
		</div>`,
	},
	{
		id: "state-offline",
		group: "States",
		title: "Offline",
		docs: "Danger border. Retry action.",
		layout: "padded",
		html: `<div id="state" data-state="offline">
			<p class="state-title">Disconnected</p>
			<p class="state-detail">The live feed dropped.</p>
			<button class="state-action" type="button">Retry</button>
		</div>`,
	},
];
