import type { DemoState } from "../types";
import { seedAccounts, seedAgents, seedProfile, seedSchedules } from "./agents";
import { seedArtifacts, seedChats } from "./chats";
import { seedChannels, seedMessages, seedPlans } from "./rooms";

/** Bump when the stored shape changes, so old browsers reseed instead of breaking. */
export const STATE_VERSION = 1;

export function seedState(now: number): DemoState {
	const agents = seedAgents(now);
	const { messages, nextMessageId } = seedMessages(now);
	return {
		version: STATE_VERSION,
		seededAt: now,
		nextMessageId,
		channels: seedChannels(),
		messages,
		agents,
		accounts: seedAccounts(),
		plans: seedPlans(now),
		schedules: seedSchedules(agents, now),
		artifacts: seedArtifacts(now),
		profile: seedProfile(),
		chats: seedChats(now),
		attachments: [],
	};
}
