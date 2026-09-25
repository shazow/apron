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
});
