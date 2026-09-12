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
 * last line under the list; the list re-reads after every action.
 */
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ConsoleCall } from "./CreateChannelDialog";

export type ArtifactRow = { file: string; url: string; status: string; pendingPrompts: number; updatedAt: string };

function when(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

export function ArtifactsView({ call, version }: { call: ConsoleCall; version: number }) {
  const [rows, setRows] = useState<ArtifactRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await call("/api/artifacts");
    setRows(result.artifacts as ArtifactRow[]);
  }, [call]);
  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh, version]);
  const open = (row: ArtifactRow) => {
    setError(""); setBusy(row.file);
    // Resume first so the server is up, then open the URL the daemon answers.
    void call("/api/artifacts", { method: "POST", body: { file: row.file } })
      .then((result) => {
        const artifact = result.artifact as ArtifactRow;
        window.open(artifact.url, "_blank", "noopener");
        return refresh();
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };
  return (
    <div id="artifacts" className="w-full overflow-y-auto p-4 md:p-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Artifacts</h2>
          <p className="text-xs text-muted-foreground">HTML the agents opened in Lavish Editor for your review. Annotate there; feedback reaches the agent that is polling.</p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Refresh artifacts" onClick={() => void refresh().catch((cause) => setError(String(cause)))}><RefreshCw /></Button>
      </div>
      <ul className="space-y-1.5">
        {rows === null && <li className="text-xs text-muted-foreground">Loading…</li>}
        {rows?.length === 0 && <li className="text-xs text-muted-foreground">No artifacts yet. Ask an agent for a plan, a comparison, or a report as a page and it appears here.</li>}
        {rows?.map((row) => (
          <li key={row.file} className="artifact flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2" data-file={row.file}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={row.file}>{row.file.split("/").pop()}</div>
              <div className="truncate text-xs text-muted-foreground" title={row.file}>{row.file}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="outline">{row.status}</Badge>
                {row.pendingPrompts > 0 && <span>{row.pendingPrompts} queued for the agent</span>}
                <span>{when(row.updatedAt)}</span>
              </div>
            </div>
            <Button type="button" size="xs" className="artifact-open" disabled={busy !== null} onClick={() => open(row)}><ExternalLink /> Open review</Button>
          </li>
        ))}
      </ul>
      <p role="alert" className="mt-2 min-h-5 text-xs text-destructive">{error}</p>
    </div>
  );
}
