import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "lenis/dist/lenis.css";
import "./home.css";
import "./hero.css";
import "./story.css";
import "./systems.css";
import "./closing.css";
import "./responsive.css";

// Geist variable, served from the installed @fontsource-variable/geist files.
const geist = localFont({
	src: "../../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
	weight: "100 900",
	variable: "--font-geist",
	display: "swap",
});

export const metadata: Metadata = { alternates: { canonical: "/" } };

// Runs before paint: a stored choice wins, otherwise the system preference.
const THEME_SCRIPT = `try{var t=localStorage.getItem("oma-home-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.omaTheme=t}catch(e){document.documentElement.dataset.omaTheme="dark"}`;

export default function HomeLayout({ children }: { children: ReactNode }) {
	return (
		<>
			<script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
			<div className={`oma-home ${geist.variable}`}>{children}</div>
		</>
	);
}
