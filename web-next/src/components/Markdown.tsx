/**
 * Purpose: Message and plan bodies as GitHub-flavored Markdown, rendered on
 * the server. Only a mermaid fence needs the browser: it becomes a client
 * island that loads the renderer on first sight, so a page without
 * diagrams ships no mermaid at all.
 */
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mermaid } from "./Mermaid";

const MENTION = /(@[a-z0-9][a-z0-9._-]*)/gi;

/** Plain text with `@names` wrapped so they read as addresses. Keys are text offsets. */
function withMentions(children: ReactNode): ReactNode {
	if (typeof children === "string") {
		const parts = children.split(MENTION);
		if (parts.length === 1) return children;
		let offset = 0;
		const out: ReactNode[] = [];
		parts.forEach((part, index) => {
			const key = `${offset}`;
			offset += part.length;
			out.push(
				index % 2 === 1 ? (
					<span
						key={key}
						className="rounded bg-sky-500/15 px-1 font-medium text-sky-300"
					>
						{part}
					</span>
				) : (
					<span key={key}>{part}</span>
				),
			);
		});
		return out;
	}
	if (Array.isArray(children))
		return children.map((child) => withMentions(child));
	return children;
}

function CodeBlock({ language, value }: { language: string; value: string }) {
	let offset = 0;
	const lines = value
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => {
			const key = `${offset}`;
			offset += line.length + 1;
			return { key, line };
		});
	return (
		<div className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
			{language && (
				<div className="border-b border-zinc-800 px-3 py-1 font-mono text-[10px] text-zinc-400">
					{language}
				</div>
			)}
			<pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
				<code>
					{lines.map(({ key, line }) => (
						<span
							key={key}
							className={`block min-w-max ${language === "diff" && line.startsWith("+") ? "bg-emerald-500/10 text-emerald-300" : language === "diff" && line.startsWith("-") ? "bg-red-500/10 text-red-300" : ""}`}
						>
							{line || " "}
						</span>
					))}
				</code>
			</pre>
		</div>
	);
}

const components: Components = {
	p: ({ children }) => (
		<p className="my-1 leading-5">{withMentions(children)}</p>
	),
	li: ({ children }) => (
		<li className="my-0.5 ml-4 list-disc">{withMentions(children)}</li>
	),
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="text-sky-400 underline underline-offset-2"
		>
			{children}
		</a>
	),
	h1: ({ children }) => (
		<h1 className="mt-2 mb-1 text-base font-semibold">{children}</h1>
	),
	h2: ({ children }) => (
		<h2 className="mt-2 mb-1 text-sm font-semibold">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>
	),
	blockquote: ({ children }) => (
		<blockquote className="my-1 border-l-2 border-sky-500/50 pl-3 text-zinc-400">
			{children}
		</blockquote>
	),
	table: ({ children }) => (
		<div className="my-1.5 overflow-x-auto">
			<table className="w-auto border-collapse text-xs">{children}</table>
		</div>
	),
	th: ({ children }) => (
		<th className="border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-left font-semibold">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="border border-zinc-800 px-2 py-1 align-top">
			{withMentions(children)}
		</td>
	),
	input: ({ checked }) => (
		<input
			type="checkbox"
			checked={Boolean(checked)}
			readOnly
			className="mr-1 align-middle"
		/>
	),
	pre: ({ children }) => <>{children}</>,
	code: ({ className, children }) => {
		const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
		const value = String(children ?? "");
		if (!className && !value.includes("\n")) {
			return (
				<code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.85em]">
					{value}
				</code>
			);
		}
		if (language === "mermaid") return <Mermaid source={value} />;
		return <CodeBlock language={language} value={value} />;
	},
};

export function Markdown({ body }: { body: string }) {
	return (
		<div className="body min-w-0 space-y-1 break-words text-sm leading-5 text-zinc-100/90">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{body}
			</ReactMarkdown>
		</div>
	);
}
