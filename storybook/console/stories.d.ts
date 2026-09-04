export interface ConsoleStory {
	id: string;
	group: "Pages" | "Components" | "States";
	title: string;
	docs: string;
}

export const STORIES: ConsoleStory[];
