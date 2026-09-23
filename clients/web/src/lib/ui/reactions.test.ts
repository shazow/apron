import { describe, expect, it } from 'vitest';
import type { ReactionSummary } from '$lib/protocol/client';
import { REACTION_PALETTE, reactionChips, whoReacted } from './reactions';

const summary = (emoji: string, users: string[], mine = false): ReactionSummary => ({
	emoji,
	count: users.length,
	user_ids: [...users].sort(),
	users: [...users].sort().map((user_id) => ({ user_id, name: user_id[0].toUpperCase() + user_id.slice(1) })),
	mine
});

describe('reaction chips', () => {
	it('shows one chip per emoji with its count and whether you reacted', () => {
		const chips = reactionChips([summary('👍', ['ada', 'bob', 'you'], true), summary('🎉', ['bob'])], 'you');
		expect(chips.map(({ emoji, count, mine }) => [emoji, count, mine])).toEqual([['👍', 3, true], ['🎉', 1, false]]);
		expect(chips[0].title).toBe('You, Ada and Bob reacted with 👍');
		expect(chips[0].label).toBe('👍 3 reactions, including yours. Remove yours');
		expect(chips[1].title).toBe('Bob reacted with 🎉');
		expect(chips[1].label).toBe('🎉 1 reaction. Add yours');
	});

	it('hides reactions on tombstones and messages nobody reacted to', () => {
		expect(reactionChips([summary('👍', ['ada'])], 'you', true)).toEqual([]);
		expect(reactionChips(undefined, 'you')).toEqual([]);
		expect(reactionChips([summary('👍', [])], 'you')).toEqual([]);
	});

	it('names who reacted, you first, and sums up a long list', () => {
		expect(whoReacted(summary('👍', ['you'], true), 'you')).toBe('You');
		expect(whoReacted(summary('👍', ['ada', 'bob']), 'you')).toBe('Ada and Bob');
		const crowd = summary('👍', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'you'], true);
		expect(whoReacted(crowd, 'you')).toBe('You, A1, A2, A3, A4, A5, A6 and 3 others');
		const unnamed: ReactionSummary = { emoji: '👀', count: 1, user_ids: ['guest_1'], users: [{ user_id: 'guest_1' }], mine: false };
		expect(whoReacted(unnamed, undefined)).toBe('guest_1');
	});

	it('offers a small fixed palette of distinct emoji', () => {
		expect(REACTION_PALETTE).toHaveLength(8);
		expect(new Set(REACTION_PALETTE).size).toBe(REACTION_PALETTE.length);
	});
});
