/**
 * Purpose: The Artifacts view — every HTML artifact an agent opened in
 * Lavish Editor for review, with what is waiting on it, and a way to open
 * the review from the console.
 *
 * Upstream deps: `/api/artifacts` (list; POST resumes one so its URL
 * answers again). Lavish itself serves the review page on its own local
 * port; the console links to it.
 *
 * Downstream consumers: `ConsoleShell` (the Artifacts tab).
 *
 * Failure modes: a resume the daemon could not perform shows Lavish's own
 * last line under the list; the list re-reads after every action. The review
 * tab is opened inside the click, before the resume request, because a popup
 * opened after an await has lost the click's user activation; a blocked popup
 * leaves a visible link instead. An unparseable timestamp renders as text.
 */
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ConsoleCall } from "./CreateChannelDialog";
import { errorText, formatDate } from "./errors";

export type ArtifactRow = { file: string; url: string; status: string; pendingPrompts: number; updatedAt: string };

export function ArtifactsView({ call, version }: { call: ConsoleCall; version: number }) {
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ file: string; url: string } | null>(null);
  const refresh = useCallback(async () => {
    const result = await call("/api/artifacts");
    setRows(Array.isArray(result.artifacts) ? (result.artifacts as ArtifactRow[]) : []);
  }, [call]);
  useEffect(() => {
    void refresh().catch((cause) => setError(errorText(cause)));
  }, [refresh, version]);
  const open = (row: ArtifactRow) => {
    setError(""); setBusy(row.file); setBlocked(null);
    // Opened now, while the click still counts as user activation; navigated
    // once the resume answers. Without "noopener" so the handle comes back,
    // and the opener link is cut by hand before any navigation.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    void call("/api/artifacts", { method: "POST", body: { file: row.file } })
      .then((result) => {
        const artifact = result.artifact as ArtifactRow;
        if (tab && !tab.closed) tab.location.href = artifact.url;
        else setBlocked({ file: row.file, url: artifact.url });
        return refresh();
      })
      .catch((cause) => {
        tab?.close();
        setError(errorText(cause));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div id="artifacts" className="w-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
      <div className="mx-auto mb-5 flex max-w-3xl items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[22px] leading-7 font-black">Artifacts</h2>
          <p className="mt-0.5 text-[15px] text-muted-foreground">HTML the agents opened in Lavish Editor for your review. Annotate there; feedback reaches the agent that is polling.</p>
        </div>
        <Button type="button" variant="ghost" size="icon-lg" className="shrink-0" aria-label="Refresh artifacts" onClick={() => void refresh().catch((cause) => setError(errorText(cause)))}><RefreshCw /></Button>
      </div>
      <ul className="mx-auto max-w-3xl overflow-hidden rounded-lg border bg-card empty:hidden">
        {rows === null && <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">Loading…</li>}
        {rows?.length === 0 && <li className="px-6 py-14 text-center text-[15px] text-muted-foreground">No artifacts yet. Ask an agent for a plan, a comparison, or a report as a page and it appears here.</li>}
        {rows?.map((row) => (
          <li key={row.file} className="artifact flex flex-wrap items-center gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]" data-file={row.file}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-bold" title={row.file}>{row.file.split("/").pop()}</div>
              <div className="truncate font-mono text-xs text-muted-foreground" title={row.file}>{row.file}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="gap-1.5"><span aria-hidden className={`size-2 rounded-full ${row.pendingPrompts > 0 ? "bg-[var(--presence-parked)]" : row.status === "active" || row.status === "open" ? "bg-[var(--presence-active)]" : "bg-[var(--presence-stopped)]"}`} />{row.status}</Badge>
                {row.pendingPrompts > 0 && <span>{row.pendingPrompts} queued for the agent</span>}
                <span>{formatDate(row.updatedAt, { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" className="artifact-open h-8 font-bold max-sm:h-11" disabled={busy !== null} onClick={() => open(row)}><ExternalLink /> Open review</Button>
            {blocked?.file === row.file && (
              <p className="basis-full text-[13px]">
                The browser blocked the new tab.{" "}
                <a className="artifact-link font-bold underline" href={blocked.url} target="_blank" rel="noopener noreferrer">Open the review</a>
              </p>
            )}
          </li>
        ))}
      </ul>
      <p role="alert" className="mx-auto mt-2 min-h-5 max-w-3xl text-[13px] text-destructive">{error}</p>
    </div>
  );
}
