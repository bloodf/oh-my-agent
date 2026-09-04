import { useEffect, useState } from "react";
import { Folder, File, ArrowUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ConsoleCall } from "./CreateChannelDialog";
export function FilePicker({
  open,
  onOpenChange,
  initialPath,
  call,
  onPick,
  directoryOnly = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPath: string;
  call: ConsoleCall;
  onPick: (path: string) => void;
  directoryOnly?: boolean;
}) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<
    { name: string; path: string; directory: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [parent, setParent] = useState("");
  useEffect(() => {
    if (!open) return;
    let stale = false;
    void call(`/api/workspace/files?path=${encodeURIComponent(path)}`)
      .then((result) => {
        if (!stale) {
          setError("");
          setEntries(result.entries as typeof entries);
          setParent(String(result.parent));
        }
      })
      .catch((e) => {
        if (!stale) {
          setEntries([]);
          setError(String(e));
        }
      });
    return () => {
      stale = true;
    };
  }, [open, path, call]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {directoryOnly ? "Choose workspace" : "Attach from this computer"}
          </DialogTitle>
          <DialogDescription>
            {directoryOnly
              ? "OMP opens in this folder using its native project configuration."
              : "Only the file path is sent. The original file stays in place."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onPick(path);
            onOpenChange(false);
          }}
        >
          <Input
            aria-label="Absolute path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/Users/you/project"
          />
          <Button type="submit">
            {directoryOnly ? "Open folder" : "Use path"}
          </Button>
        </form>
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => setPath(parent)}
          disabled={!parent || parent === path}
        >
          <ArrowUp />
          Parent folder
        </Button>
        <ScrollArea className="h-72">
          <div className="grid gap-1">
            {entries
              .filter((e) => !directoryOnly || e.directory)
              .map((entry) => (
                <Button
                  key={entry.path}
                  variant="ghost"
                  className="justify-start font-normal"
                  onClick={() => {
                    if (entry.directory) setPath(entry.path);
                    else {
                      onPick(entry.path);
                      onOpenChange(false);
                    }
                  }}
                >
                  {entry.directory ? <Folder /> : <File />}
                  <span className="truncate">{entry.name}</span>
                </Button>
              ))}
          </div>
        </ScrollArea>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
