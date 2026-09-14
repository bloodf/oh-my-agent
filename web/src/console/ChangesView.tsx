import { FileDiff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ConsoleCall } from "./CreateChannelDialog";

/**
 * Purpose: Browse Git workspace changes and inspect staged or working-tree diffs.
 * Public API: ChangesView and ChangesViewProps.
 * Upstream deps: authenticated ConsoleCall plus shadcn Button, Tabs, Badge, and ScrollArea.
 * Downstream consumers: console workspace shell.
 * Failure modes: list and diff request errors remain visible with focused retry actions.
 * Performance: one changes request per refresh and one diff request per file/side selection.
 */

type WorkspaceFile = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

type ChangesPayload = {
  cwd: string;
  root: string;
  branch: string;
  files: WorkspaceFile[];
};

type DiffPayload = {
  path: string;
  diff: string;
  truncated: boolean;
  binary: boolean;
};

type DiffSide = "staged" | "working";

export type ChangesViewProps = {
  cwd: string;
  call: ConsoleCall;
};

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function isWorkspaceFile(value: unknown): value is WorkspaceFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<WorkspaceFile>;
  return (
    typeof file.path === "string" &&
    typeof file.indexStatus === "string" &&
    typeof file.worktreeStatus === "string" &&
    typeof file.staged === "boolean" &&
    typeof file.unstaged === "boolean" &&
    typeof file.untracked === "boolean"
  );
}

function lineStyle(line: string) {
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "text-muted-foreground";
  if (line.startsWith("+")) return "border-l-2 border-[var(--presence-active)] bg-[var(--presence-active)]/10 text-[#006146] dark:text-[#7fe0b5]";
  if (line.startsWith("-")) return "border-l-2 border-[#e01e5a] bg-[#e01e5a]/8 text-[#a3103f] dark:text-[#f59ab5]";
  if (line.startsWith("@@")) return "border-l-2 border-[#1d9bd1] bg-[#1d9bd1]/10 text-[#0b4c80] dark:text-[#7cc5f0]";
  return "border-l-2 border-transparent text-foreground/80";
}

const LETTER_STYLE: Record<string, string> = {
  M: "border-[#e8912d]/50 bg-[#e8912d]/12 text-[#9a5b0f] dark:text-[#f2b96a]",
  A: "border-[var(--presence-active)]/50 bg-[var(--presence-active)]/12 text-[#007a5a] dark:text-[#5fd3a3]",
  D: "border-[#e01e5a]/50 bg-[#e01e5a]/10 text-[#b3124a] dark:text-[#f47aa0]",
  R: "border-[#1d9bd1]/50 bg-[#1d9bd1]/12 text-[#0b4c80] dark:text-[#7cc5f0]",
  "?": "border-input bg-muted text-muted-foreground",
};

/** The first non-blank porcelain letter picks the pill colour. */
function letterStyle(file: WorkspaceFile) {
  const letter = `${file.indexStatus}${file.worktreeStatus}`.replace(/[\s.]/g, "").charAt(0);
  return LETTER_STYLE[letter] ?? LETTER_STYLE["?"];
}

function statusLabel(file: WorkspaceFile) {
  if (file.untracked) return "untracked";
  if (file.staged && file.unstaged) return "staged + working";
  if (file.staged) return "staged";
  return "working";
}

export function ChangesView({ cwd, call }: ChangesViewProps) {
  const [changes, setChanges] = useState<ChangesPayload | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [side, setSide] = useState<DiffSide>("working");
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [diffRetry, setDiffRetry] = useState(0);
  const selectedFile =
    changes?.files.find((file) => file.path === selectedPath) ?? null;
  const effectiveSide: DiffSide = selectedFile && side === "staged" && selectedFile.staged
    ? "staged"
    : selectedFile && side === "working" && (selectedFile.unstaged || selectedFile.untracked)
      ? "working"
      : selectedFile?.staged ? "staged" : "working";

  const loadChanges = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await call(
        `/api/workspace/changes?cwd=${encodeURIComponent(cwd)}`,
      );
      const files = Array.isArray(payload.files)
        ? payload.files.filter(isWorkspaceFile)
        : [];
      const next: ChangesPayload = {
        cwd: typeof payload.cwd === "string" ? payload.cwd : cwd,
        root: typeof payload.root === "string" ? payload.root : cwd,
        branch: typeof payload.branch === "string" ? payload.branch : "",
        files,
      };
      setChanges(next);
      setDiffRetry((value) => value + 1);
      setSelectedPath((current) =>
        files.some((file) => file.path === current)
          ? current
          : (files[0]?.path ?? ""),
      );
    } catch (cause) {
      setChanges(null);
      setSelectedPath("");
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [call, cwd]);

  useEffect(() => {
    void Promise.resolve().then(loadChanges);
  }, [loadChanges]);

  useEffect(() => {
    if (!selectedFile) return;
    let current = true;
    const query = `cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selectedFile.path)}&staged=${effectiveSide === "staged"}`;
    void Promise.resolve().then(async () => {
      if (!current) return;
      setDiffLoading(true);
      setDiffError("");
      setDiff(null);
      try {
        const payload = await call(`/api/workspace/diff?${query}`);
        if (!current) return;
        setDiff({
          path: typeof payload.path === "string" ? payload.path : selectedFile.path,
          diff: typeof payload.diff === "string" ? payload.diff : "",
          truncated: payload.truncated === true,
          binary: payload.binary === true,
        });
      } catch (cause) {
        if (current) setDiffError(errorMessage(cause));
      } finally {
        if (current) setDiffLoading(false);
      }
    });
    return () => {
      current = false;
    };
  }, [call, cwd, selectedFile, effectiveSide, diffRetry]);

  return (
    <section
      className="@container/changes flex min-h-0 min-w-0 flex-1 flex-col px-3 py-4 sm:px-6 sm:py-6"
      aria-labelledby="changes-heading"
    >
      <div className="flex w-full min-w-0 items-center justify-between gap-3 pb-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <h2 id="changes-heading" className="text-[22px] leading-7 font-black">
              Changes
            </h2>
            {changes?.branch && (
              <Badge variant="outline" className="h-6 max-w-48 truncate rounded-md font-mono text-xs">
                {changes.branch}
              </Badge>
            )}
          </div>
          <p
            className="truncate font-mono text-[13px] text-muted-foreground"
            title={changes?.root ?? cwd}
          >
            {changes?.root ?? cwd}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          className="shrink-0"
          disabled={loading}
          aria-label="Refresh workspace changes"
          onClick={() => void loadChanges()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load workspace changes</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void loadChanges()}
          >
            Try again
          </Button>
        </Alert>
      )}
      {loading && !changes && (
        <div className="grid min-h-0 w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 @[56rem]/changes:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
          <Skeleton className="min-h-64" />
          <Skeleton className="min-h-64" />
        </div>
      )}
      {!loading && !error && changes?.files.length === 0 && (
        <div className="flex w-full flex-1 items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
          <div>
            <FileDiff className="mx-auto mb-3 size-10 text-muted-foreground" />
            <p className="text-lg font-black">Working tree is clean</p>
            <p className="mt-1 text-[15px] text-muted-foreground">
              No staged, modified, or untracked files.
            </p>
          </div>
        </div>
      )}

      {changes && changes.files.length > 0 && (
        <div className="grid min-h-0 w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 @[56rem]/changes:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
          <div className="min-h-40 min-w-0 overflow-hidden rounded-lg border bg-card @[56rem]/changes:min-h-0">
            <div className="flex h-9 items-center border-b px-3 text-[13px] font-bold text-muted-foreground">
              {changes.files.length} changed{" "}
              {changes.files.length === 1 ? "file" : "files"}
            </div>
            <ScrollArea className="h-[min(34vh,20rem)] @[56rem]/changes:h-[calc(100%-2.25rem)]">
              <ul className="grid gap-px p-1">
                {changes.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-ring/40 ${selectedPath === file.path ? "bg-accent text-accent-foreground hover:bg-accent" : ""}`}
                      onClick={() => {
                        setSelectedPath(file.path);
                        setSide(
                          file.unstaged || file.untracked
                            ? "working"
                            : "staged",
                        );
                      }}
                    >
                      <span
                        aria-hidden
                        className={`row-span-2 inline-flex h-5 min-w-7 items-center justify-center rounded-md border px-1 font-mono text-[11px] font-bold ${letterStyle(file)}`}
                      >
                        {`${file.indexStatus}${file.worktreeStatus}`.trim() || "?"}
                      </span>
                      <span
                        className="block truncate font-mono text-[13px] text-foreground"
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      {file.originalPath && (
                        <span className="col-start-2 block truncate text-xs text-muted-foreground">
                          from {file.originalPath}
                        </span>
                      )}
                      <span className="col-start-2 text-xs text-muted-foreground">
                        {statusLabel(file)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>

          <div className="flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-lg border bg-card @[56rem]/changes:min-h-0">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b bg-muted/50 px-3 py-1.5">
              <div className="min-w-0">
                <p
                  className="truncate font-mono text-[13px] font-bold"
                  title={selectedFile?.path}
                >
                  {selectedFile?.path}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedFile?.originalPath
                    ? `Renamed from ${selectedFile.originalPath}`
                    : "Unified diff"}
                </p>
              </div>
              <Tabs
                value={effectiveSide}
                onValueChange={(value) => setSide(value as DiffSide)}
                className="max-w-full min-w-0 overflow-x-auto [scrollbar-width:none]"
              >
                <TabsList variant="line" aria-label="Diff source">
                  <TabsTrigger
                    value="working"
                    disabled={
                      !selectedFile?.unstaged && !selectedFile?.untracked
                    }
                  >
                    Working
                  </TabsTrigger>
                  <TabsTrigger value="staged" disabled={!selectedFile?.staged}>
                    Staged
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {diffError && (
              <Alert variant="destructive" className="m-3">
                <AlertTitle>Could not load diff</AlertTitle>
                <AlertDescription>{diffError}</AlertDescription>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setDiffRetry((value) => value + 1)}
                >
                  Try again
                </Button>
              </Alert>
            )}
            {diffLoading && (
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            )}
            {!diffLoading && diff?.binary && (
              <div className="m-auto p-8 text-center">
                <p className="text-lg font-black">Binary file</p>
                <p className="mt-1 text-[15px] text-muted-foreground">
                  Text diff is not available for this file.
                </p>
              </div>
            )}
            {!diffLoading && diff && !diff.binary && diff.diff.length === 0 && (
              <div className="m-auto p-8 text-center text-[15px] text-muted-foreground">
                No {effectiveSide} diff for this file.
              </div>
            )}
            {!diffLoading && diff && !diff.binary && diff.diff.length > 0 && (
              <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-background">
                <pre
                  className="w-max min-w-full py-2 font-mono text-[13px] leading-5"
                  aria-label={`${side} diff for ${diff.path}`}
                >
                  <code>
                    {diff.diff.split("\n").map((line, index) => (
                      <span
                        key={index}
                        className={`block min-h-5 px-3 ${lineStyle(line)}`}
                      >
                        {line || " "}
                      </span>
                    ))}
                  </code>
                </pre>
              </div>
            )}
            {diff?.truncated && (
              <Alert className="m-3">
                <AlertTitle>Diff truncated</AlertTitle>
                <AlertDescription>
                  Only the first part of this diff is shown.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
