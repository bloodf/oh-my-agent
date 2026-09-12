/**
 * Purpose: Render a message or plan body as Markdown — GitHub-flavored, with
 * fenced code kept as code, `diff` fences tinted, and `mermaid` fences drawn
 * as diagrams — so what an agent writes in a room reads the way it was meant.
 *
 * Upstream deps: react-markdown + remark-gfm for the tree; mermaid, loaded
 * on first use, for diagrams; the theme store for the diagram palette.
 *
 * Downstream consumers: `Message.tsx` (MessageBody), which the transcript,
 * threads, and plans all render through.
 *
 * Failure modes: a diagram that does not parse falls back to its source in a
 * code block with mermaid's own error line under it, so a typo never blanks
 * a message. HTML in a body is text, not markup: without a raw-HTML plugin,
 * react-markdown never turns it into elements.
 */
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { getResolvedThemeMode, subscribeTheme } from "@/lib/theme";

const MENTION = /(@[a-z0-9][a-z0-9._-]*)/gi;

/** Plain text with `@names` wrapped so they read as addresses. */
function withMentions(children: ReactNode): ReactNode {
  if (typeof children === "string") {
    const parts = children.split(MENTION);
    if (parts.length === 1) return children;
    return parts.map((part, index) =>
      MENTION.test(part) && index % 2 === 1 ? (
        <span key={index} className="rounded bg-primary/10 px-1 font-medium text-primary">{part}</span>
      ) : (
        part
      ),
    );
  }
  if (Array.isArray(children)) return children.map((child, index) => <span key={index}>{withMentions(child)}</span>);
  return children;
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border bg-muted/40 not-prose">
      {language && (
        <div className="border-b px-3 py-1 font-mono text-[10px] text-muted-foreground">{language}</div>
      )}
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
        <code>
          {value.replace(/\n$/, "").split("\n").map((line, lineIndex) => (
            <span
              key={lineIndex}
              className={`block min-w-max ${language === "diff" && line.startsWith("+") ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300" : language === "diff" && line.startsWith("-") ? "bg-red-500/10 text-red-800 dark:text-red-300" : ""}`}
            >
              {line || " "}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** A mermaid diagram, rendered off the main bundle path on first sight. */
function Mermaid({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const mode = useSyncExternalStore(subscribeTheme, getResolvedThemeMode, getResolvedThemeMode);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mode === "dark" ? "dark" : "default" });
        const rendered = await mermaid.render(`mmd-${id}`, source);
        if (!cancelled) setSvg(rendered.svg);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [source, mode, id]);
  if (error !== null) {
    return (
      <div className="not-prose">
        <CodeBlock language="mermaid" value={source} />
        <p role="alert" className="mt-1 text-xs text-destructive">diagram did not render: {error.split("\n")[0]}</p>
      </div>
    );
  }
  if (svg === null) return <div className="mermaid my-1.5 h-16 animate-pulse rounded-lg bg-muted/40" aria-busy="true" />;
  // mermaid's output is SVG it produced from text it parsed under
  // securityLevel strict, never raw HTML from the message.
  return <div className="mermaid my-1.5 overflow-x-auto not-prose" data-diagram="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const components: Components = {
  p: ({ children }) => <p className="my-1 leading-5">{withMentions(children)}</p>,
  li: ({ children }) => <li className="my-0.5">{withMentions(children)}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2 hover:text-primary/80">{children}</a>
  ),
  h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-primary/50 pl-3 text-muted-foreground">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto not-prose"><table className="w-auto border-collapse text-xs">{children}</table></div>
  ),
  th: ({ children }) => <th className="border bg-muted/40 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top">{withMentions(children)}</td>,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} readOnly className="mr-1 align-middle" />,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
    const value = String(children ?? "");
    // Fenced blocks arrive with a language class or a trailing newline;
    // inline code has neither.
    if (!className && !value.includes("\n")) {
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{value}</code>;
    }
    if (language === "mermaid") return <Mermaid source={value} />;
    return <CodeBlock language={language} value={value} />;
  },
};

export function Markdown({ body }: { body: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {body}
    </ReactMarkdown>
  );
}
