import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoGuard } from "@site/components/demo/DemoGuard";
import "./console.css";

export const metadata: Metadata = {
	title: "Console demo · oh-my-agent",
	description: "The real oh-my-agent web console, running against a mocked in-browser daemon.",
};

export default function ConsoleLayout({ children }: { children: ReactNode }) {
	return <DemoGuard>{children}</DemoGuard>;
}
