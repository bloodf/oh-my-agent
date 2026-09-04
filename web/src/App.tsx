import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsoleApp } from "./ConsoleApp";

export default function App() {
	return (
		<TooltipProvider>
			<ConsoleApp />
			<Toaster />
		</TooltipProvider>
	);
}
