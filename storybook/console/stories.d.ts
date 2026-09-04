export interface ConsoleStory {
	id: string;
	group: "Pages" | "Components" | "States";
	title: string;
	docs: string;
	layout: "fullscreen" | "padded" | "dialog";
	html: string;
}

export const STORIES: ConsoleStory[];
