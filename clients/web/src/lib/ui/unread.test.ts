import { describe, expect, it } from 'vitest';
import { createTimeline } from '$lib/protocol/reducer';
import type { RoomSnapshot } from '$lib/protocol/client';
import type { MessageRecord } from '$lib/protocol/types';
import { UnreadTracker } from './unread.svelte';

const me = { user_id: 'guest_me', name: 'sam' };

const message = (id: number, roomId: string, from = 'ada', fields: Partial<MessageRecord> = {}): MessageRecord => ({
	message_id: String(id), log_id: String(id), room_id: roomId, from: { user_id: from }, body: { text: `hello ${id}` }, ...fields
});

function room(id: string, messages: MessageRecord[], fields: Partial<RoomSnapshot> = {}): RoomSnapshot {
	const timeline = { ...createTimeline(id), events: Object.fromEntries(messages.map((event) => [event.message_id, event])), order: messages.map((event) => event.message_id) };
	return { id, title: id, timeline, recovering: false, loaded: true, loading: false, ...fields };
}

describe('unread tracking', () => {
	it('counts arrivals from others, never history or your own messages', () => {
		const tracker = new UnreadTracker();
		tracker.observe([room('general', [message(10, 'general')], { latestLogId: '10' }), room('random', [], { latestLogId: '10' })], me, 'general', true);
		expect(tracker.total).toBe(0);
		tracker.observe([
			room('general', [message(10, 'general')]),
			room('random', [message(20, 'random'), message(21, 'random', me.user_id), message(22, 'random')])
		], me, 'general', true);
		expect(tracker.byRoom).toEqual({ random: 2 });
		expect(tracker.total).toBe(2);
	});

	it('clears a room once you read its end, or your read cursor passes its arrivals', () => {
		const tracker = new UnreadTracker();
		tracker.observe([room('general', [], { latestLogId: '10' }), room('random', [], { latestLogId: '10' })], me, 'general', true);
		// Arrivals in the open pane count while you aren't reading its end (scrolled up, or the tab is hidden).
		const general = room('general', [message(20, 'general'), message(21, 'general')]);
		const random = room('random', [message(30, 'random'), message(31, 'random')]);
		tracker.observe([general, random], me, 'general', false);
		expect(tracker.byRoom).toEqual({ general: 2, random: 2 });
		tracker.observe([general, random], me, 'general', true);
		expect(tracker.byRoom).toEqual({ random: 2 });
		// Read on another device up to 30: only 31 is left.
		tracker.observe([general, { ...random, readMessageId: '30' }], me, 'general', true);
		expect(tracker.total).toBe(1);
	});

	it('drops arrivals that were deleted', () => {
		const tracker = new UnreadTracker();
		tracker.observe([room('general', [], { latestLogId: '10' }), room('random', [], { latestLogId: '10' })], me, 'general', true);
		tracker.observe([room('general', []), room('random', [message(20, 'random')])], me, 'general', true);
		expect(tracker.total).toBe(1);
		tracker.observe([room('general', []), room('random', [message(20, 'random', 'ada', { deleted: true })])], me, 'general', true);
		expect(tracker.total).toBe(0);
	});
});
