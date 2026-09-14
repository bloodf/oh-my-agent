import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const title = "oh-my-agent — the daemon that never sleeps";
const description =
	"An oh-my-pi plugin that runs autonomous, long-lived agents as a local daemon. Agents keep working after the TUI closes, talk in persistent rooms, and stay observable from the TUI, the CLI, or a browser console.";

export const metadata: Metadata = {
	metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3300"),
	title,
	description,
	icons: { icon: "/home/favicon.svg" },
	openGraph: {
		title,
		description,
		type: "website",
		siteName: "oh-my-agent",
		images: [{ url: "/home/social.png", width: 1280, height: 720, alt: "oh-my-agent social card" }],
	},
	twitter: { card: "summary_large_image", title, description, images: ["/home/social.png"] },
};

export const viewport: Viewport = { themeColor: "#07040a", colorScheme: "dark light" };

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body>{children}</body>
		</html>
	);
}
