import { Hash, Plus, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { AUTHENTICATION_REQUIRED, api, readToken } from "@/lib/api";
import {
	type AgentInfo,
	type ConsoleEvent,
	type ConsoleStateKind,
	HUMAN_AUTHOR,
	type RoomInfo,
	type RoomMessage,
} from "@/lib/types";

const RECONNECT_BASE_MS = 200;
const RECONNECT_CAP_MS = 5000;

function timestamp(createdAt: number): string {
	const when = new Date(createdAt);
	return `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
}

function authorClass(author: string): string {
	if (author === HUMAN_AUTHOR) return "role-you text-amber-300";
	if (author === "system") return "role-system text-muted-foreground";
	return "role-agent text-sky-300";
}

function reactionGroups(reactions: RoomMessage["reactions"]) {
	const map = new Map<string, string[]>();
	for (const reaction of reactions) {
		const actors = map.get(reaction.emoji) ?? [];
		actors.push(reaction.actor);
		map.set(reaction.emoji, actors);
	}
	return [...map.entries()];
}

function MessageBody({ body }: { body: string }) {
	const parts: { type: "text" | "code"; value: string }[] = [];
	let prose: string[] = [];
	let fence: string[] | null = null;
	const flush = () => {
		if (prose.length === 0) return;
		parts.push({ type: "text", value: prose.join("\n") });
		prose = [];
	};
	for (const line of body.split("\n")) {
		if (line.trim().startsWith("```")) {
			if (fence === null) {
				flush();
				fence = [];
			} else {
				parts.push({ type: "code", value: fence.join("\n") });
				fence = null;
			}
			continue;
		}
		if (fence !== null) fence.push(line);
		else prose.push(line);
	}
	flush();
	if (fence !== null) parts.push({ type: "text", value: fence.join("\n") });
	return (
		<div className="body space-y-1 text-sm leading-relaxed">
			{parts.map((part) =>
				part.type === "code" ? (
					<pre
						key={`code:${part.value}`}
						className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs"
					>
						{part.value}
					</pre>
				) : (
					<p key={`text:${part.value}`} className="whitespace-pre-wrap">
						{part.value}
					</p>
				),
			)}
		</div>
	);
}

export function ConsoleApp() {
	const [{ token, remoteMode }] = useState(readToken);
	const [authRequired, setAuthRequired] = useState(
		remoteMode && token.length === 0,
	);
	const [authToken, setAuthToken] = useState("");
	const [authError, setAuthError] = useState("");
	const tokenRef = useRef(token);

	const [channels, setChannels] = useState<RoomInfo[]>([]);
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [messages, setMessages] = useState<RoomMessage[]>([]);
	const [currentRoom, setCurrentRoom] = useState<string | null>(
		new URLSearchParams(location.search).get("room"),
	);
	const [unread, setUnread] = useState<Set<string>>(new Set());
	const [threadRoot, setThreadRoot] = useState<number | null>(null);
	const [status, setStatus] = useState<ConsoleStateKind>("connecting");
	const [statusDetail, setStatusDetail] = useState("Reaching the daemon.");
	const [notice, setNotice] = useState("");
	const [composer, setComposer] = useState("");
	const [threadComposer, setThreadComposer] = useState("");
	const [newChannel, setNewChannel] = useState("");
	const [agentForm, setAgentForm] = useState({
		name: "",
		description: "",
		spawns: "",
		rooms: "",
		body: "",
	});
	const [agentError, setAgentError] = useState("");
	const [killTarget, setKillTarget] = useState<string | null>(null);
	const [keepChildren, setKeepChildren] = useState(false);
	const [logs, setLogs] = useState("");
	const [injectDraft, setInjectDraft] = useState<Record<string, string>>({});
	const [budgets, setBudgets] = useState<Map<string, number>>(new Map());
	const sockets = useRef<WebSocket[]>([]);
	const reconnect = useRef(0);
	const messagesEl = useRef<HTMLDivElement>(null);

	const call = useCallback(
		(path: string, init: { method?: string; body?: unknown } = {}) =>
			api(path, {
				...init,
				token: tokenRef.current,
				remoteMode,
				onUnauthorized: () => {
					setAuthRequired(true);
					for (const socket of sockets.current) socket.close();
					window.__showOperatorAuth?.();
				},
			}),
		[remoteMode],
	);

	const showNotice = (text: string) => {
		setNotice(text);
		if (text) toast.message(text);
	};

	const refreshChannels = useCallback(async () => {
		const payload = await call("/api/channels");
		setChannels(payload.channels as RoomInfo[]);
		return payload.channels as RoomInfo[];
	}, [call]);

	const refreshAgents = useCallback(async () => {
		const payload = await call("/api/agents");
		setAgents(payload.agents as AgentInfo[]);
	}, [call]);

	const refreshMessages = useCallback(
		async (room: string) => {
			const payload = await call(
				`/api/channels/${encodeURIComponent(room)}/messages`,
			);
			setMessages(payload.messages as RoomMessage[]);
			setStatus(
				(payload.messages as RoomMessage[]).length === 0 ? "empty" : null,
			);
		},
		[call],
	);

	const connect = useCallback(async () => {
		if (authRequired) return;
		const url = new URL("/api/events", location.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (remoteMode) {
			const payload = await call("/api/ws-ticket", { method: "POST" });
			url.searchParams.set("ticket", String(payload.ticket));
		} else {
			url.searchParams.set("token", tokenRef.current);
		}
		const socket = new WebSocket(url);
		sockets.current.push(socket);
		socket.addEventListener("open", () => {
			reconnect.current = 0;
			void refreshChannels();
			if (currentRoom) void refreshMessages(currentRoom);
			void refreshAgents();
		});
		socket.addEventListener("message", (event) => {
			let frame: ConsoleEvent;
			try {
				frame = JSON.parse(String(event.data)) as ConsoleEvent;
			} catch {
				return;
			}
			if (frame.type === "message") {
				if (frame.message.room === currentRoom) {
					void refreshMessages(frame.message.room);
				} else {
					setUnread((set) => new Set(set).add(frame.message.room));
				}
			} else if (frame.type === "reaction" && frame.room === currentRoom) {
				void refreshMessages(frame.room);
			} else if (frame.type === "channel") {
				void refreshChannels();
			} else if (frame.type === "budget" && frame.budgetUsd !== undefined) {
				const ceiling = frame.budgetUsd;
				setBudgets((map) => new Map(map).set(frame.account, ceiling));
				void refreshAgents();
			} else if (
				frame.type === "agent" ||
				frame.type === "definition" ||
				frame.type === "membership" ||
				frame.type === "schedule"
			) {
				void refreshAgents();
			}
		});
		socket.addEventListener("close", () => {
			sockets.current = sockets.current.filter((item) => item !== socket);
			if (authRequired) return;
			reconnect.current += 1;
			const delay = Math.min(
				RECONNECT_BASE_MS * 2 ** reconnect.current,
				RECONNECT_CAP_MS,
			);
			window.setTimeout(() => {
				void connect();
			}, delay);
		});
	}, [
		authRequired,
		call,
		currentRoom,
		refreshAgents,
		refreshChannels,
		refreshMessages,
		remoteMode,
	]);

	// Boot once per auth gate. Listing every callback would reconnect the
	// socket on every render of those identities.
	useEffect(() => {
		if (authRequired) return;
		let cancelled = false;
		const boot = async () => {
			setStatus("connecting");
			setStatusDetail("Reaching the daemon.");
			try {
				const list = await refreshChannels();
				if (cancelled) return;
				const room = currentRoom ?? list[0]?.id ?? null;
				setCurrentRoom(room);
				if (room) await refreshMessages(room);
				await refreshAgents();
				await connect();
			} catch (error) {
				if (error === AUTHENTICATION_REQUIRED || cancelled) return;
				setStatus("offline");
				setStatusDetail(error instanceof Error ? error.message : String(error));
			}
		};
		void boot();
		return () => {
			cancelled = true;
			for (const socket of sockets.current) socket.close();
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: boot once per auth
	}, [authRequired]);

	useEffect(() => {
		const box = messagesEl.current;
		if (box === null) return;
		box.scrollTop = box.scrollHeight;
	}, [messages, currentRoom]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || threadRoot === null) return;
			event.preventDefault();
			const rootId = threadRoot;
			setThreadRoot(null);
			queueMicrotask(() => {
				document
					.querySelector<HTMLElement>(
						`.message[data-id="${rootId}"] .thread-open`,
					)
					?.focus();
			});
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [threadRoot]);

	const roots = useMemo(
		() => messages.filter((message) => message.parentId === null),
		[messages],
	);
	const thread = useMemo(
		() =>
			threadRoot === null
				? []
				: messages.filter((message) => message.threadRootId === threadRoot),
		[messages, threadRoot],
	);

	const selectRoom = (id: string) => {
		setCurrentRoom(id);
		setThreadRoot(null);
		setUnread((set) => {
			const next = new Set(set);
			next.delete(id);
			return next;
		});
		void refreshMessages(id).catch((error) => {
			if (error === AUTHENTICATION_REQUIRED) return;
			setStatus("load-failure");
			setStatusDetail(error instanceof Error ? error.message : String(error));
		});
	};

	const send = async (body: string, parentId: number | null) => {
		if (currentRoom === null || body.trim().length === 0) return;
		try {
			await call(`/api/channels/${encodeURIComponent(currentRoom)}/messages`, {
				method: "POST",
				body: { body, author: HUMAN_AUTHOR, parentId },
			});
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error));
		}
	};

	const authenticate = async (value: string) => {
		setAuthError("");
		try {
			const response = await fetch("/api/session", {
				method: "POST",
				headers: { "X-Operator-Token": value },
			});
			if (!response.ok) {
				setAuthError("Operator token refused. Re-enter the token.");
				return;
			}
			const payload = await response.json();
			sessionStorage.setItem("oh-my-agent.operator-token", value);
			location.replace(`/?ticket=${encodeURIComponent(payload.ticket)}`);
		} catch {
			setAuthError("Authentication unavailable. Try again.");
		}
	};

	if (authRequired) {
		return (
			<section
				id="operator-auth"
				className="flex min-h-svh items-center justify-center p-6"
			>
				<Card className="w-full max-w-sm">
					<CardHeader>
						<CardTitle id="operator-auth-title">
							Operator authentication
						</CardTitle>
						<CardDescription>
							Enter the operator token to open this remote console.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							id="operator-auth-form"
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void authenticate(authToken);
							}}
						>
							<div className="grid gap-2">
								<Label htmlFor="operator-token">Operator token</Label>
								<Input
									id="operator-token"
									type="password"
									autoComplete="off"
									required
									value={authToken}
									onChange={(event) => setAuthToken(event.target.value)}
								/>
							</div>
							<Button type="submit">Open console</Button>
							<p
								id="operator-auth-error"
								role="alert"
								className="text-sm text-destructive"
							>
								{authError}
							</p>
						</form>
					</CardContent>
				</Card>
			</section>
		);
	}

	return (
		<div className="flex h-svh bg-background text-foreground">
			<a className="skip-link sr-only focus:not-sr-only" href="#composer-input">
				Skip to composer
			</a>
			<nav
				id="sidebar"
				aria-label="Channels and agents"
				className="flex w-64 shrink-0 flex-col border-r bg-sidebar"
			>
				<div className="flex items-center justify-between px-3 py-3">
					<p className="text-sm font-medium">Channels</p>
					<Button
						size="icon-xs"
						variant="ghost"
						onClick={() =>
							document.getElementById("new-channel-input")?.focus()
						}
						aria-label="Create channel"
					>
						<Plus />
					</Button>
				</div>
				<ScrollArea className="flex-1">
					{/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox+option is the test contract */}
					<ul
						id="channels"
						role="listbox"
						aria-label="Channels"
						className="px-2 pb-3"
					>
						{channels.map((channel) => {
							const active = channel.id === currentRoom;
							const isUnread = unread.has(channel.id);
							return (
								<li key={channel.id} role="presentation">
									<button
										type="button"
										role="option"
										data-id={channel.id}
										aria-selected={active}
										className={`channel flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
											active
												? "active bg-sidebar-accent font-medium"
												: "text-muted-foreground hover:bg-sidebar-accent/60"
										} ${isUnread ? "unread font-medium text-foreground" : ""}`}
										onClick={() => selectRoom(channel.id)}
									>
										<Hash className="size-3.5 opacity-60" />
										<span className="truncate">
											{channel.name ?? channel.id}
										</span>
										{isUnread ? (
											<span className="ml-auto size-1.5 rounded-full bg-sky-400" />
										) : null}
									</button>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
				<Separator />
				<div className="flex items-center justify-between px-3 py-2">
					<p className="text-sm font-medium">Agents</p>
					<Button
						size="icon-xs"
						variant="ghost"
						onClick={() => document.getElementById("new-agent-name")?.focus()}
						aria-label="Create agent"
					>
						<Plus />
					</Button>
				</div>
				<form
					id="new-channel"
					className="grid gap-2 px-3 pb-3"
					onSubmit={(event) => {
						event.preventDefault();
						const id = newChannel.trim();
						if (id.length === 0) return;
						setNewChannel("");
						void call("/api/channels", { method: "POST", body: { id } })
							.then(async () => {
								const list = await refreshChannels();
								if (list.some((channel) => channel.id === id)) selectRoom(id);
							})
							.catch((error) =>
								showNotice(
									error instanceof Error ? error.message : String(error),
								),
							);
					}}
				>
					<Input
						id="new-channel-input"
						placeholder="#new-channel"
						value={newChannel}
						onChange={(event) => setNewChannel(event.target.value)}
					/>
					<Button id="new-channel-create" type="submit" size="sm">
						Create
					</Button>
					<p id="new-channel-error" />
				</form>
				<ScrollArea className="max-h-48">
					<ul id="agents" className="space-y-1 px-2 pb-3">
						{agents.map((agent) => {
							const member = currentRoom
								? (agent.rooms ?? []).includes(currentRoom)
								: false;
							return (
								<li
									key={agent.name}
									className="agent flex flex-wrap items-center gap-1 rounded-md px-2 py-1 text-sm"
									data-name={agent.name}
								>
									<span className="agent-name min-w-0 flex-1 truncate">
										{agent.name} ({agent.state})
									</span>
									{currentRoom ? (
										<Button
											type="button"
											size="xs"
											variant="outline"
											className={
												member
													? "membership-toggle member"
													: "membership-toggle"
											}
											data-member={String(member)}
											onClick={() => {
												const path = `/api/agents/${encodeURIComponent(agent.name)}/rooms`;
												void (
													member
														? call(
																`${path}/${encodeURIComponent(currentRoom)}`,
																{ method: "DELETE" },
															)
														: call(path, {
																method: "POST",
																body: { room: currentRoom },
															})
												).then((result) => {
													showNotice(
														typeof result.notice === "string"
															? result.notice
															: "",
													);
													void refreshAgents();
												});
											}}
										>
											{member ? "Leave" : "Join"}
										</Button>
									) : null}
									<Button
										type="button"
										size="xs"
										variant="ghost"
										className="definition-edit"
										data-name={agent.name}
										aria-label={`Edit ${agent.name}'s definition`}
									>
										Edit
									</Button>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
				<form
					id="new-agent"
					className="grid gap-2 border-t px-3 py-3"
					onSubmit={(event) => {
						event.preventDefault();
						setAgentError("");
						const rooms = agentForm.rooms
							.split(",")
							.map((entry) => entry.trim())
							.filter(Boolean);
						const payload: Record<string, unknown> = {
							name: agentForm.name.trim(),
							description: agentForm.description.trim(),
							spawns: agentForm.spawns
								.split(",")
								.map((entry) => entry.trim())
								.filter(Boolean),
							body: agentForm.body,
						};
						if (rooms.length > 0) payload.rooms = rooms;
						void call("/api/agents", { method: "POST", body: payload })
							.then((created) => {
								showNotice(
									typeof created.notice === "string"
										? created.notice
										: "Agent created.",
								);
								setAgentForm({
									name: "",
									description: "",
									spawns: "",
									rooms: "",
									body: "",
								});
								void refreshAgents();
							})
							.catch((error) =>
								setAgentError(
									error instanceof Error ? error.message : String(error),
								),
							);
					}}
				>
					<Input
						id="new-agent-name"
						placeholder="name"
						value={agentForm.name}
						onChange={(event) =>
							setAgentForm((form) => ({ ...form, name: event.target.value }))
						}
					/>
					<Input
						id="new-agent-description"
						placeholder="description"
						value={agentForm.description}
						onChange={(event) =>
							setAgentForm((form) => ({
								...form,
								description: event.target.value,
							}))
						}
					/>
					<Input
						id="new-agent-spawns"
						placeholder="spawns (comma separated)"
						value={agentForm.spawns}
						onChange={(event) =>
							setAgentForm((form) => ({ ...form, spawns: event.target.value }))
						}
					/>
					<Input
						id="new-agent-rooms"
						placeholder="rooms (comma separated)"
						value={agentForm.rooms}
						onChange={(event) =>
							setAgentForm((form) => ({ ...form, rooms: event.target.value }))
						}
					/>
					<Textarea
						id="new-agent-body"
						placeholder="system prompt"
						value={agentForm.body}
						onChange={(event) =>
							setAgentForm((form) => ({ ...form, body: event.target.value }))
						}
					/>
					<p id="new-agent-error" className="text-sm text-destructive">
						{agentError}
					</p>
					<Button id="new-agent-create" type="submit" size="sm">
						Create agent
					</Button>
				</form>
			</nav>

			<main id="main" className="flex min-w-0 flex-1 flex-col">
				{/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: tests assert banner on this header */}
				<header
					id="current-channel"
					role="banner"
					className="flex h-12 items-center justify-between border-b px-4"
				>
					<div className="flex items-center gap-2">
						<h1 className="text-sm font-medium">
							{currentRoom ?? "No channel"}
						</h1>
						{notice ? (
							<p
								id="notice"
								role="status"
								className="text-xs text-muted-foreground"
							>
								{notice}
							</p>
						) : (
							<p id="notice" role="status" />
						)}
					</div>
					<div className="flex max-w-[50%] flex-wrap justify-end gap-1">
						{agents
							.filter((agent) =>
								currentRoom ? (agent.rooms ?? []).includes(currentRoom) : false,
							)
							.map((agent) => (
								<Badge
									key={agent.name}
									variant="secondary"
									className="font-normal"
								>
									{agent.name}
									<span className="ml-1 text-muted-foreground">
										{agent.state}
									</span>
								</Badge>
							))}
					</div>
				</header>

				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling of the transcript */}
				<div
					id="messages"
					ref={messagesEl}
					role="log"
					aria-label="Channel transcript"
					tabIndex={0}
					className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
				>
					{status === "connecting" ||
					status === "offline" ||
					status === "load-failure" ||
					status === "empty" ? (
						<div
							id="state"
							data-state={status}
							className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-6 text-center"
						>
							<p className="state-title font-medium">
								{status === "connecting"
									? "Connecting…"
									: status === "offline"
										? "Daemon offline"
										: status === "load-failure"
											? "Transcript failed to load"
											: `${currentRoom ?? "This channel"} is quiet`}
							</p>
							<p className="state-detail mt-1 text-sm text-muted-foreground">
								{status === "empty"
									? "Nothing has been said here yet."
									: statusDetail}
							</p>
							{status === "offline" || status === "load-failure" ? (
								<Button
									className="state-action mt-4"
									variant="outline"
									onClick={() => location.reload()}
								>
									Retry
								</Button>
							) : null}
							{status === "empty" ? (
								<Button
									className="state-action mt-4"
									variant="outline"
									onClick={() =>
										document.getElementById("composer-input")?.focus()
									}
								>
									Write the first message
								</Button>
							) : null}
						</div>
					) : (
						<div id="state" hidden />
					)}
					{roots.map((message, index) => {
						const grouped =
							index > 0 && roots[index - 1]?.author === message.author;
						return (
							<article
								key={message.id}
								data-id={String(message.id)}
								className={`message ${authorClass(message.author)} ${grouped ? "grouped mt-1" : "mt-4"}`}
							>
								{grouped ? null : (
									<div className="meta mb-0.5 flex items-baseline gap-2 text-xs">
										<span
											className={`author font-medium ${authorClass(message.author)}`}
										>
											{message.author}
										</span>
										<span className="timestamp text-muted-foreground">
											{timestamp(message.createdAt)}
										</span>
									</div>
								)}
								<MessageBody body={message.body} />
								{(message.mentions ?? []).map((mention) => (
									<span
										key={mention}
										className="mention mr-1 inline-flex rounded-full border px-2 text-xs text-sky-300"
									>
										@{mention}
									</span>
								))}
								<span className="reactions mt-1 inline-flex gap-1">
									{reactionGroups(message.reactions).map(([emoji, actors]) => (
										<button
											key={emoji}
											type="button"
											className={`reaction rounded-full border px-2 text-xs ${
												actors.includes(HUMAN_AUTHOR)
													? "mine border-sky-400 text-sky-300"
													: "text-muted-foreground"
											}`}
											onClick={() =>
												void call(
													`/api/messages/${message.id}/reactions/toggle`,
													{
														method: "POST",
														body: { actor: HUMAN_AUTHOR, emoji },
													},
												)
											}
										>
											{emoji} {actors.length}
										</button>
									))}
								</span>
								{message.replyCount > 0 ? (
									<button
										type="button"
										className="thread-open ml-2 text-xs text-sky-300"
										onClick={() => {
											setThreadRoot(message.id);
											queueMicrotask(() =>
												document.getElementById("thread-close")?.focus(),
											);
										}}
									>
										{message.replyCount}{" "}
										{message.replyCount === 1 ? "reply" : "replies"}
									</button>
								) : null}
							</article>
						);
					})}
				</div>

				<form
					id="composer"
					className="flex items-end gap-2 border-t p-3"
					onSubmit={(event) => {
						event.preventDefault();
						const body = composer.trim();
						setComposer("");
						void send(body, null);
					}}
				>
					<Textarea
						id="composer-input"
						rows={1}
						aria-label="Message the channel"
						placeholder="Message the channel"
						className="min-h-10 flex-1 resize-none"
						value={composer}
						onChange={(event) => setComposer(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.shiftKey) return;
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}}
					/>
					<Button id="composer-send" type="submit">
						<Send />
						Send
					</Button>
					<p className="composer-hint basis-full text-xs text-muted-foreground">
						<kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a
						new line
					</p>
				</form>
			</main>

			<aside
				id="thread"
				aria-label="Thread"
				hidden={threadRoot === null}
				className="flex w-[24rem] shrink-0 flex-col border-l bg-background"
			>
				<header className="flex h-12 items-center justify-between border-b px-3">
					<span id="thread-title" className="text-sm font-medium">
						Thread
					</span>
					<Button
						id="thread-close"
						type="button"
						size="icon-xs"
						variant="ghost"
						aria-label="Close thread"
						onClick={() => setThreadRoot(null)}
					>
						<X />
					</Button>
				</header>
				<div
					id="thread-messages"
					className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
				>
					{thread.map((message) => (
						<article
							key={message.id}
							data-id={String(message.id)}
							className={`message mt-3 ${authorClass(message.author)}`}
						>
							<div className="meta mb-0.5 flex gap-2 text-xs">
								<span
									className={`author font-medium ${authorClass(message.author)}`}
								>
									{message.author}
								</span>
								<span className="timestamp text-muted-foreground">
									{timestamp(message.createdAt)}
								</span>
							</div>
							<MessageBody body={message.body} />
							<span className="reactions mt-1 inline-flex gap-1">
								{reactionGroups(message.reactions).map(([emoji, actors]) => (
									<button
										key={emoji}
										type="button"
										className={`reaction rounded-full border px-2 text-xs ${
											actors.includes(HUMAN_AUTHOR)
												? "mine border-sky-400 text-sky-300"
												: "text-muted-foreground"
										}`}
										onClick={() =>
											void call(
												`/api/messages/${message.id}/reactions/toggle`,
												{
													method: "POST",
													body: { actor: HUMAN_AUTHOR, emoji },
												},
											)
										}
									>
										{emoji} {actors.length}
									</button>
								))}
							</span>
						</article>
					))}
				</div>
				<form
					id="thread-composer"
					className="flex items-end gap-2 border-t p-3"
					onSubmit={(event) => {
						event.preventDefault();
						const body = threadComposer.trim();
						setThreadComposer("");
						void send(body, threadRoot);
					}}
				>
					<Textarea
						id="thread-composer-input"
						rows={1}
						aria-label="Reply in thread"
						placeholder="Reply in thread"
						className="min-h-10 flex-1 resize-none"
						value={threadComposer}
						onChange={(event) => setThreadComposer(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Enter" || event.shiftKey) return;
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}}
					/>
					<Button id="thread-composer-send" type="submit">
						Reply
					</Button>
					<p className="composer-hint basis-full text-xs text-muted-foreground">
						<kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a
						new line
					</p>
				</form>
			</aside>

			<section
				id="ops"
				aria-label="Operations"
				hidden={threadRoot !== null}
				className="flex w-72 shrink-0 flex-col border-l bg-sidebar"
			>
				<div className="px-3 py-3 text-sm font-medium">Agents</div>
				<ScrollArea className="flex-1 px-3">
					<ul id="ops-agents" className="space-y-3 pb-3">
						{agents.map((agent) => (
							<li
								key={agent.name}
								className="ops-agent rounded-lg border bg-card p-2"
								data-name={agent.name}
							>
								<div className="ops-name flex items-center justify-between text-sm">
									<span>{agent.name}</span>
									<Badge variant="outline">{agent.state}</Badge>
								</div>
								<div className="mt-2 flex gap-1">
									<Button
										type="button"
										size="xs"
										variant="destructive"
										className="ops-kill"
										onClick={() => {
											setKeepChildren(false);
											setKillTarget(agent.name);
										}}
									>
										Stop
									</Button>
									<Button
										type="button"
										size="xs"
										variant="outline"
										className="ops-logs"
										onClick={() =>
											void call(
												`/api/agents/${encodeURIComponent(agent.name)}/logs`,
											).then((result) => {
												const lines = result.lines as string[];
												setLogs(
													lines.length === 0
														? `No logs for ${agent.name}.`
														: lines.join("\n"),
												);
											})
										}
									>
										Logs
									</Button>
									{currentRoom ? (
										<Button
											type="button"
											size="xs"
											variant="ghost"
											className={
												(agent.rooms ?? []).includes(currentRoom)
													? "membership-toggle member"
													: "membership-toggle"
											}
											data-member={String(
												(agent.rooms ?? []).includes(currentRoom),
											)}
											onClick={() => {
												const member = (agent.rooms ?? []).includes(
													currentRoom,
												);
												const path = `/api/agents/${encodeURIComponent(agent.name)}/rooms`;
												void (
													member
														? call(
																`${path}/${encodeURIComponent(currentRoom)}`,
																{ method: "DELETE" },
															)
														: call(path, {
																method: "POST",
																body: { room: currentRoom },
															})
												).then((result) => {
													showNotice(
														typeof result.notice === "string"
															? result.notice
															: "",
													);
													void refreshAgents();
												});
											}}
										>
											{(agent.rooms ?? []).includes(currentRoom)
												? "Leave"
												: "Join"}
										</Button>
									) : null}
								</div>
								<form
									className="ops-inject mt-2"
									onSubmit={(event) => {
										event.preventDefault();
										const message = injectDraft[agent.name]?.trim() ?? "";
										if (message.length === 0) return;
										setInjectDraft((draft) => ({ ...draft, [agent.name]: "" }));
										void call(
											`/api/agents/${encodeURIComponent(agent.name)}/inject`,
											{ method: "POST", body: { message } },
										).then((result) =>
											showNotice(
												result.queued
													? `Queued for ${result.name}; it reads this when it resumes.`
													: `Sent to ${result.name}.`,
											),
										);
									}}
								>
									<Input
										className="ops-inject-input h-7"
										placeholder="Message this agent"
										value={injectDraft[agent.name] ?? ""}
										onChange={(event) =>
											setInjectDraft((draft) => ({
												...draft,
												[agent.name]: event.target.value,
											}))
										}
									/>
								</form>
							</li>
						))}
					</ul>
					<h2 className="mt-2 text-xs font-medium text-muted-foreground">
						Accounts
					</h2>
					<ul id="ops-accounts" className="mt-2 space-y-2 pb-3">
						{[
							...new Set(agents.map((agent) => agent.account).filter(Boolean)),
						].map((account) => (
							<li
								key={account}
								className="ops-account rounded-lg border bg-card p-2"
							>
								<div className="ops-name text-sm">{account}</div>
								<div className="ops-budget text-xs text-muted-foreground">
									{budgets.has(account as string)
										? `$${budgets.get(account as string)}`
										: "metered"}
								</div>
								<form
									className="ops-bump mt-2"
									onSubmit={(event) => {
										event.preventDefault();
										const data = new FormData(event.currentTarget);
										const budgetUsd = Number(data.get("budget"));
										void call(
											`/api/accounts/${encodeURIComponent(String(account))}/bump`,
											{ method: "POST", body: { budgetUsd } },
										).then((result) =>
											showNotice(`Raised ${account} to $${result.budgetUsd}.`),
										);
									}}
								>
									<Input
										name="budget"
										className="ops-bump-input h-7"
										type="number"
										step="any"
										placeholder="New ceiling"
									/>
								</form>
							</li>
						))}
					</ul>
					<p id="ops-error" className="text-xs text-destructive" />
					<h2
						id="ops-logs-title"
						className="text-xs font-medium text-muted-foreground"
					>
						Logs
					</h2>
					<pre
						id="ops-logs-output"
						role="log"
						className="mt-2 mb-3 max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs"
					>
						{logs}
					</pre>
				</ScrollArea>
			</section>

			<dialog id="definition-dialog" aria-labelledby="definition-heading">
				<form method="dialog" id="definition-form">
					<h2 id="definition-heading">Edit definition</h2>
					<p id="definition-path" />
					<label id="definition-changes-label" htmlFor="definition-changes">
						Changes, as a JSON object
					</label>
					<textarea
						id="definition-changes"
						rows={14}
						aria-label="Definition changes as JSON"
					/>
					<p id="definition-error" role="status" />
					<div className="definition-actions">
						<button type="submit" id="definition-save" value="save">
							Save
						</button>
						<button type="button" id="definition-cancel">
							Cancel
						</button>
					</div>
				</form>
			</dialog>

			<dialog
				id="ops-kill-dialog"
				open={killTarget !== null}
				onClose={() => setKillTarget(null)}
				className="rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
			>
				<form
					id="ops-kill-form"
					method="dialog"
					onSubmit={(event) => {
						event.preventDefault();
						if (killTarget === null) return;
						const name = killTarget;
						setKillTarget(null);
						void call(`/api/agents/${encodeURIComponent(name)}/kill`, {
							method: "POST",
							body: { keepChildren },
						}).then((result) => {
							showNotice(
								result.cascaded
									? `Stopped ${result.name} and everything under it.`
									: `Stopped ${result.name}. Its children are still running.`,
							);
							void refreshAgents();
						});
					}}
				>
					<h2 id="ops-kill-heading" className="text-base font-medium">
						Stop an agent
					</h2>
					<p
						id="ops-kill-detail"
						className="mt-2 text-sm text-muted-foreground"
					>
						Stop {killTarget}
						{keepChildren
							? " and leave children running."
							: " and its children."}
					</p>
					<label
						id="ops-kill-keep-label"
						htmlFor="ops-kill-keep"
						className="mt-3 flex items-center gap-2 text-sm"
					>
						<Checkbox
							id="ops-kill-keep"
							checked={keepChildren}
							onCheckedChange={(value) => setKeepChildren(value === true)}
						/>
						Keep children running (reparent them to root)
					</label>
					<div className="ops-dialog-actions mt-4 flex justify-end gap-2">
						<Button
							id="ops-kill-cancel"
							type="button"
							variant="outline"
							onClick={() => setKillTarget(null)}
						>
							Cancel
						</Button>
						<Button id="ops-kill-confirm" type="submit" variant="destructive">
							Stop
						</Button>
					</div>
				</form>
			</dialog>
		</div>
	);
}

declare global {
	interface Window {
		__showOperatorAuth?: (
			message?: string,
			clearToken?: boolean,
			refusedToken?: string,
		) => void;
	}
}
