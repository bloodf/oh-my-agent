import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleShell } from "./console/ConsoleShell";

// The storybook and its fixtures are a separate chunk, fetched only when the
// storybook server marks the page; the production console never loads them.
const Storybook = lazy(() =>
  import("./console/Storybook").then((module) => ({ default: module.Storybook })),
);

export default function App() {
  return (
    <TooltipProvider>
      {document.documentElement.dataset.storybook === "true" ? (
        <Suspense fallback={null}>
          <Storybook />
        </Suspense>
      ) : (
        <ConsoleShell />
      )}
      <Toaster />
    </TooltipProvider>
  );
}
