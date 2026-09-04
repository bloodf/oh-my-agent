import { FileDiff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
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
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-700 dark:text-red-300";
  if (line.startsWith("@@")) return "bg-blue-500/10 text-blue-700 dark:text-blue-300";
  return "text-foreground/80";
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
      className="flex min-h-0 flex-1 flex-col p-3 sm:p-5"
      aria-labelledby="changes-heading"
    >
      <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 pb-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id="changes-heading" className="text-xl font-semibold">
              Changes
            </h2>
            {changes?.branch && (
              <Badge variant="outline" className="max-w-48 truncate">
                {changes.branch}
              </Badge>
            )}
          </div>
          <p
            className="truncate text-sm text-muted-foreground"
            title={changes?.root ?? cwd}
          >
            {changes?.root ?? cwd}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={loading}
          aria-label="Refresh workspace changes"
          onClick={() => void loadChanges()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mx-auto max-w-[1400px]">
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
        <div className="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 gap-3 md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
          <Skeleton className="min-h-64" />
          <Skeleton className="min-h-64" />
        </div>
      )}
      {!loading && !error && changes?.files.length === 0 && (
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 items-center justify-center rounded-xl border border-dashed p-10 text-center">
          <div>
            <FileDiff className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">Working tree is clean</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No staged, modified, or untracked files.
            </p>
          </div>
        </div>
      )}

      {changes && changes.files.length > 0 && (
        <div className="mx-auto grid min-h-0 w-full max-w-[1400px] flex-1 gap-3 md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]">
          <div className="min-h-40 overflow-hidden rounded-xl border bg-card md:min-h-0">
            <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              {changes.files.length} changed{" "}
              {changes.files.length === 1 ? "file" : "files"}
            </div>
            <ScrollArea className="h-[min(34vh,20rem)] md:h-[calc(100%-2.25rem)]">
              <ul className="p-1.5">
                {changes.files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className={`w-full rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${selectedPath === file.path ? "bg-muted" : ""}`}
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
                        className="block truncate font-mono text-xs text-foreground"
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      {file.originalPath && (
                        <span className="block truncate text-[11px] text-muted-foreground">
                          from {file.originalPath}
                        </span>
                      )}
                      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[10px]"
                        >
                          {file.indexStatus}
                          {file.worktreeStatus}
                        </Badge>
                        {statusLabel(file)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>

          <div className="flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-xl border bg-card md:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <div className="min-w-0">
                <p
                  className="truncate font-mono text-xs font-medium"
                  title={selectedFile?.path}
                >
                  {selectedFile?.path}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {selectedFile?.originalPath
                    ? `Renamed from ${selectedFile.originalPath}`
                    : "Unified diff"}
                </p>
              </div>
              <Tabs
                value={effectiveSide}
                onValueChange={(value) => setSide(value as DiffSide)}
              >
                <TabsList aria-label="Diff source">
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
                <p className="font-medium">Binary file</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Text diff is not available for this file.
                </p>
              </div>
            )}
            {!diffLoading && diff && !diff.binary && diff.diff.length === 0 && (
              <div className="m-auto p-8 text-center text-sm text-muted-foreground">
                No {effectiveSide} diff for this file.
              </div>
            )}
            {!diffLoading && diff && !diff.binary && diff.diff.length > 0 && (
              <ScrollArea className="min-h-0 flex-1 bg-muted/20">
                <pre
                  className="min-w-max py-2 font-mono text-xs leading-5"
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
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
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
