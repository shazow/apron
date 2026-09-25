import { describe, expect, it } from 'vitest';
import { collapseMentions, draftMentions, draftText, insertMention, mentionQuery } from './draft';

const people = [
	{ id: 'ada_1', name: 'Ada' },
	{ id: 'lovelace', name: 'Ada Lovelace' },
	{ id: 'bob', name: 'Bob' },
	{ id: 'sam_a', name: 'Sam' },
	{ id: 'sam_b', name: 'sam' }
];

function typed(text: string, caret = text.length, final = false) {
	return collapseMentions([text], people, { caret, final });
}

describe('composer mentions', () => {
	it('chips a finished @user_id or @name and sends @user_id', () => {
		expect(typed('hi @bob ').parts).toEqual(['hi ', { id: 'bob' }, ' ']);
		expect(typed('hi @Bob, there').parts).toEqual(['hi ', { id: 'bob' }, ', there']);
		expect(draftText(typed('hi @BOB and').parts)).toBe('hi @bob and');
		// A multi-word name, case-insensitive.
		const both = typed('ask @ada lovelace now');
		expect(both.parts).toEqual(['ask ', { id: 'lovelace' }, ' now']);
		expect(both.caret).toBe('ask @lovelace now'.length);
	});

	it('waits while a mention is still being typed', () => {
		expect(typed('hi @bob').changed).toBe(false);
		// The caret sits inside the mention.
		expect(typed('hi @bob there', 5).changed).toBe(false);
		// "Ada " could still become "Ada Lovelace".
		expect(typed('hi @Ada Lo').changed).toBe(false);
		expect(typed('hi @Ada ').changed).toBe(false);
		// Once it can't, the shorter name is the mention.
		expect(typed('hi @Ada s').parts).toEqual(['hi ', { id: 'ada_1' }, ' s']);
	});

	it('chips a mention that ends the draft when sending', () => {
		expect(typed('hi @bob', 7, true).parts).toEqual(['hi ', { id: 'bob' }]);
		expect(typed('hi @Ada', 7, true).parts).toEqual(['hi ', { id: 'ada_1' }]);
	});

	it('leaves ambiguous names, unknown handles, emails, system IDs and code as text', () => {
		expect(typed('hi @sam there').changed).toBe(false);
		expect(typed('hi @sam_a there').parts).toEqual(['hi ', { id: 'sam_a' }, ' there']);
		expect(typed('hi @nobody there').changed).toBe(false);
		expect(typed('mail ada@bob now').changed).toBe(false);
		expect(typed('from @@system x').changed).toBe(false);
		expect(typed('`@bob` and ```\n@bob\n``` done', 0, true).changed).toBe(false);
		expect(typed('`x` @bob ').parts).toEqual(['`x` ', { id: 'bob' }, ' ']);
	});

	it('takes IDs the directory knows beyond the room', () => {
		const known = collapseMentions(['cc @carol_9 '], people, { caret: 12, isUser: (id) => id === 'carol_9' });
		expect(known.parts).toEqual(['cc ', { id: 'carol_9' }, ' ']);
	});

	it('keeps existing chips and moves the caret across new ones', () => {
		const collapsed = collapseMentions([{ id: 'bob' }, ' and @Ada s'], people, { caret: 15 });
		expect(collapsed.parts).toEqual([{ id: 'bob' }, ' and ', { id: 'ada_1' }, ' s']);
		expect(collapsed.caret).toBe('@bob and @ada_1 s'.length);
	});

	it('finds the query at the caret and swaps it for a chip', () => {
		expect(mentionQuery(['hi @ad'], 6)).toEqual({ query: 'ad', start: 3 });
		expect(mentionQuery(['hi @ada lo'], 10)).toEqual({ query: 'ada lo', start: 3 });
		expect(mentionQuery(['hi @'], 4)).toEqual({ query: '', start: 3 });
		expect(mentionQuery(['a@b'], 3)).toBeUndefined();
		// A chip before the caret is not a query.
		expect(mentionQuery([{ id: 'bob' }, ' x'], 6)).toBeUndefined();
		expect(insertMention(['hi @ad!'], 3, 6, 'ada_1')).toEqual({ parts: ['hi ', { id: 'ada_1' }, ' !'], caret: 10 });
		expect(insertMention(['hi @ad there'], 3, 6, 'ada_1')).toEqual({ parts: ['hi ', { id: 'ada_1' }, ' there'], caret: 10 });
		expect(insertMention([], 0, 0, 'bob')).toEqual({ parts: [{ id: 'bob' }, ' '], caret: 5 });
	});
});

describe('draft mentions', () => {
	it('lists each chip once, and drops one whose chip was deleted', () => {
		expect(draftMentions(['hi ', { id: 'bob' }, ' and ', { id: 'carol' }, ' and ', { id: 'bob' }])).toEqual(['bob', 'carol']);
		expect(draftMentions(['hi @bob, typed but not picked'])).toEqual([]);
	});
});
