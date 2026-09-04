import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleShell } from "./console/ConsoleShell";
import { Storybook } from "./console/Storybook";

export default function App() {
  return (
    <TooltipProvider>
      {document.documentElement.dataset.storybook === "true" ? (
        <Storybook />
      ) : (
        <ConsoleShell />
      )}
      <Toaster />
    </TooltipProvider>
  );
}
