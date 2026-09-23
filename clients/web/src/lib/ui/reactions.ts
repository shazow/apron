import type { ReactionSummary } from '$lib/protocol/client';

/** The fixed palette the React action offers (one emoji sequence each, the interoperable baseline). */
export const REACTION_PALETTE = ['👍', '❤️', '😂', '🎉', '😮', '😢', '👀', '✅'] as const;

/** How many names a chip's tooltip lists before summing up the rest. */
const NAMES_MAX = 8;

/** One reaction chip under a message: the emoji, how many reacted, and whether you did. */
export interface ReactionChip {
	emoji: string;
	count: number;
	mine: boolean;
	/** Who reacted, for the tooltip: "You, Ada and Bob reacted with 👍". */
	title: string;
	/** What a screen reader hears, including what a click does. */
	label: string;
}

/** "You, Ada and 3 others": you first, then others in the summary's order. */
export function whoReacted(summary: ReactionSummary, you: string | undefined): string {
	const names: string[] = [];
	if (summary.mine || (you !== undefined && summary.user_ids.includes(you))) names.push('You');
	for (const user of summary.users) {
		if (user.user_id === you) continue;
		names.push(user.name || user.user_id);
	}
	if (names.length === 0) return '';
	if (names.length === 1) return names[0];
	if (names.length > NAMES_MAX) {
		const shown = names.slice(0, NAMES_MAX - 1);
		return `${shown.join(', ')} and ${names.length - shown.length} others`;
	}
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The chips to show under a message: none for tombstones or messages nobody reacted to. */
export function reactionChips(summaries: readonly ReactionSummary[] | undefined, you: string | undefined, deleted = false): ReactionChip[] {
	if (deleted || !summaries) return [];
	return summaries
		.filter((summary) => summary.count > 0)
		.map((summary) => {
			const who = whoReacted(summary, you);
			const count = `${summary.count} ${summary.count === 1 ? 'reaction' : 'reactions'}`;
			return {
				emoji: summary.emoji,
				count: summary.count,
				mine: summary.mine,
				title: who ? `${who} reacted with ${summary.emoji}` : summary.emoji,
				label: `${summary.emoji} ${count}${summary.mine ? ', including yours. Remove yours' : '. Add yours'}`
			};
		});
}
