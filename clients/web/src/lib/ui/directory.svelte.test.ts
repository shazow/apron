import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { ClientSnapshot, RoomListing } from '$lib/protocol/client';
import { renderMarkdown } from '$lib/protocol/markdown';
import type { Identity } from '$lib/protocol/types';
import { directory } from './directory.svelte';
import { blankSnapshot } from './session.svelte';

const ada: Identity = { user_id: 'ada', name: 'Ada' };
const bo: Identity = { user_id: 'bo', name: 'Bo' };

const listing = (id: string, title: string): RoomListing => ({ id, title, record: { room_id: id, title }, members: [], joined: true });

/** What the client emits for every frame: fresh records around the same identities. */
function snapshot(users: Identity[], fields: Partial<ClientSnapshot> = {}): ClientSnapshot {
	return {
		...blankSnapshot(),
		authenticated: true,
		you: ada,
		users: Object.fromEntries(users.map((user) => [user.user_id, user])),
		recordedUsers: {},
		userAliases: {},
		rooms: [],
		directory: [listing('lobby', 'Lobby')],
		...fields
	};
}

/** Renders bodies the way a message row does, counting how often any of them re-renders. */
function renderRows(count: number): { renders: () => number; html: () => string[]; stop: () => void } {
	let renders = 0;
	const html: string[] = [];
	const stop = $effect.root(() => {
		for (let index = 0; index < count; index++) {
			const body = $derived.by(() => {
				renders++;
				return renderMarkdown(`**hi** @bo, see @lobby (${index})`, directory.resolve);
			});
			$effect(() => {
				html[index] = body;
			});
		}
	});
	flushSync();
	return { renders: () => renders, html: () => html, stop };
}

describe('directory', () => {
	it('re-renders no message bodies for a frame that changes no one', () => {
		directory.apply(snapshot([ada, bo]), undefined);
		const rows = renderRows(200);
		const before = rows.renders();
		for (let frame = 0; frame < 10; frame++) {
			directory.apply(snapshot([ada, bo], { typing: [{ room: 'lobby', from: bo }] }), undefined);
			flushSync();
		}
		expect(rows.renders() - before).toBe(0);
		rows.stop();
	});

	it('re-renders bodies when a name or a room title changes', () => {
		directory.apply(snapshot([ada, bo]), undefined);
		const rows = renderRows(3);
		expect(rows.html()[0]).toContain('@Bo');
		directory.apply(snapshot([ada, { user_id: 'bo', name: 'Bobby' }]), undefined);
		flushSync();
		expect(rows.html()[0]).toContain('@Bobby');
		directory.apply(snapshot([ada, { user_id: 'bo', name: 'Bobby' }], { directory: [listing('lobby', 'Front hall')] }), undefined);
		flushSync();
		expect(rows.html()[0]).toContain('Front hall');
		rows.stop();
	});

	it('renders field by field: the kept object, then the recorded one, then the user_id', () => {
		directory.apply(snapshot([ada, { user_id: 'bo', avatar: 'https://example.com/bo.png' }]), 'https://example.com');
		// Bo's kept object has no name: the message's from supplies it, the kept one the avatar.
		expect(directory.name({ user_id: 'bo', name: 'Bo then' })).toBe('Bo then');
		expect(directory.avatar({ user_id: 'bo', name: 'Bo then' })).toBe('https://example.com/bo.png');
		// Ada's kept name wins over an old from.
		expect(directory.name({ user_id: 'ada', name: 'Ada Lovelace' })).toBe('Ada');
		// No kept object and no name anywhere: the user_id.
		expect(directory.name({ user_id: 'guest_7' })).toBe('guest_7');
	});

	it('resolves a mention of someone known only from a record by the recorded name', () => {
		directory.apply(snapshot([ada], { recordedUsers: { guest_7: { user_id: 'guest_7', name: 'Seven' } } }), undefined);
		expect(directory.resolve('guest_7')).toEqual({ kind: 'user', id: 'guest_7', name: 'Seven', me: false });
		expect(directory.resolve('guest_8')).toBeUndefined();
	});

	it('tells when another known user shows under the same name', () => {
		const impostor = { user_id: 'guest_9', name: 'Ada' };
		directory.apply(snapshot([ada, bo], { recordedUsers: { guest_9: impostor, bo: { user_id: 'bo', name: 'Bo' } } }), undefined);
		// A kept user and one known only from a message share "Ada": both show their handle.
		expect(directory.sharesName(impostor)).toBe(true);
		expect(directory.sharesName(ada)).toBe(true);
		// Bo's kept and recorded objects are the same user.
		expect(directory.sharesName({ user_id: 'bo', name: 'Bo' })).toBe(false);
		// An old message of Ada's renders under her kept name, and a retired ID counts as the identity that replaced it.
		directory.apply(snapshot([ada, bo], { recordedUsers: { guest_2: { user_id: 'guest_2', name: 'Ada' } }, userAliases: { guest_2: 'ada' } }), undefined);
		expect(directory.name({ user_id: 'guest_2', name: 'Guest' })).toBe('Ada');
		expect(directory.sharesName({ user_id: 'guest_2', name: 'Guest' })).toBe(false);
		expect(directory.sharesName(ada)).toBe(false);
	});
});
