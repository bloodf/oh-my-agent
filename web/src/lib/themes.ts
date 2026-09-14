/**
 * Curated workspace themes modeled on Slack's sidebar themes. A theme colors
 * only the workspace chrome (rail, toolbar, sidebar); content surfaces come
 * from the light and dark token sets in index.css, so every theme keeps the
 * AAA text contrast those tokens guarantee.
 */
export type WorkspaceTheme = {
	id: string;
	name: string;
	/** CSS custom properties without the leading `--ws-`. */
	chrome: Record<string, string>;
};

const onDark = {
	text: "#ffffff",
	"text-dim": "#d1d2d3",
	hover: "rgb(255 255 255 / 10%)",
	"hover-strong": "rgb(255 255 255 / 20%)",
	border: "rgb(255 255 255 / 12%)",
	search: "rgb(255 255 255 / 16%)",
	"search-hover": "rgb(255 255 255 / 24%)",
	tile: "#ffffff",
	"badge-text": "#ffffff",
	"active-text": "#ffffff",
};

export const themes: WorkspaceTheme[] = [
	{
		id: "aubergine",
		name: "Aubergine",
		chrome: {
			...onDark,
			rail: "#2b0a2c",
			toolbar: "#350d36",
			sidebar: "#3f0e40",
			"sidebar-end": "#350d36",
			active: "#1164a3",
			badge: "#cd2553",
			"tile-text": "#3f0e40",
		},
	},
	{
		id: "ochin",
		name: "Ochin",
		chrome: {
			...onDark,
			rail: "#1b2530",
			toolbar: "#1f2b37",
			sidebar: "#303e4d",
			"sidebar-end": "#28343f",
			active: "#1164a3",
			badge: "#e0584a",
			"tile-text": "#253341",
		},
	},
	{
		id: "hoth",
		name: "Hoth",
		chrome: {
			rail: "#dedee5",
			toolbar: "#dcdce3",
			sidebar: "#f8f8fa",
			"sidebar-end": "#efeff3",
			text: "#1d1c1d",
			"text-dim": "#4f4e50",
			hover: "rgb(29 28 29 / 7%)",
			"hover-strong": "rgb(29 28 29 / 14%)",
			border: "rgb(29 28 29 / 12%)",
			search: "rgb(255 255 255 / 80%)",
			"search-hover": "#ffffff",
			tile: "#1d1c1d",
			"tile-text": "#ffffff",
			active: "#0b4c80",
			"active-text": "#ffffff",
			badge: "#cd2553",
			"badge-text": "#ffffff",
		},
	},
	{
		id: "monument",
		name: "Monument",
		chrome: {
			...onDark,
			rail: "#042e30",
			toolbar: "#05373a",
			sidebar: "#084e52",
			"sidebar-end": "#063e41",
			active: "#f79f66",
			"active-text": "#1d1c1d",
			badge: "#f79f66",
			"badge-text": "#1d1c1d",
			"tile-text": "#063e41",
		},
	},
	{
		id: "work-hard",
		name: "Work Hard",
		chrome: {
			...onDark,
			rail: "#271d25",
			toolbar: "#2c222a",
			sidebar: "#3e313c",
			"sidebar-end": "#342932",
			active: "#2d6b61",
			badge: "#dc7b54",
			"tile-text": "#332731",
		},
	},
	{
		id: "nocturne",
		name: "Nocturne",
		chrome: {
			...onDark,
			rail: "#0b0c0f",
			toolbar: "#111317",
			sidebar: "#19171d",
			"sidebar-end": "#141217",
			active: "#1164a3",
			badge: "#cd2553",
			"tile-text": "#19171d",
		},
	},
];

export const DEFAULT_THEME_ID = "aubergine";
