import { describe, expect, it } from 'vitest';
import { createTimeline } from '$lib/protocol/reducer';
import type { RoomSnapshot } from '$lib/protocol/client';
import type { MessageRecord } from '$lib/protocol/types';
import { MentionTracker } from './mentions.svelte';

const me = { user_id: 'guest_me', name: 'sam' };

const mention = (id: number, roomId: string): MessageRecord => ({
	message_id: String(id), log_id: String(id), room_id: roomId, from: { user_id: 'ada' }, body: { text: `@guest_me look ${id}` }
});

function room(id: string, messages: MessageRecord[], fields: Partial<RoomSnapshot> = {}): RoomSnapshot {
	const timeline = { ...createTimeline(id), events: Object.fromEntries(messages.map((event) => [event.message_id, event])), order: messages.map((event) => event.message_id) };
	return { id, title: id, timeline, recovering: false, loaded: true, loading: false, ...fields };
}

describe('mention tracking', () => {
	it('never pings history, including a thread’s history loaded after it was first seen', () => {
		const tracker = new MentionTracker();
		const general = room('general', [mention(10, 'general')], { latestLogId: '10' });
		const thread = room('t1', [], { parentRoomId: 'general', latestLogId: '20', loaded: false });
		tracker.observe([general, thread], me, 'general', true);
		// The thread's history arrives when it is opened: older than its watermark, so no ping.
		tracker.observe([general, room('t1', [mention(15, 't1'), mention(20, 't1')], { parentRoomId: 'general', latestLogId: '20' })], me, 'general', true);
		expect(tracker.pinged).toEqual([]);
		expect(tracker.byRoom).toEqual({});
		tracker.dispose();
	});

	it('pings new arrivals and badges a thread’s mentions on its parent room', () => {
		const tracker = new MentionTracker();
		const general = room('general', [], { latestLogId: '10' });
		const thread = room('t1', [], { parentRoomId: 'general', latestLogId: '10' });
		tracker.observe([general, thread], me, 'general', true);
		tracker.observe([general, room('t1', [mention(30, 't1')], { parentRoomId: 'general' })], me, 'general', true);
		expect(tracker.pinged).toEqual(['30']);
		expect(tracker.byRoom).toEqual({ general: 1, t1: 1 });
		// In the open pane, above the fold: it joins the jump bar instead.
		tracker.observe([room('general', [mention(40, 'general')]), room('t1', [mention(30, 't1')], { parentRoomId: 'general' })], me, 'general', false);
		expect(tracker.unseen).toEqual(['40']);
		expect(tracker.byRoom).toEqual({ general: 1, t1: 1 });
		// Opening the thread clears its badge; the parent keeps its own until it is opened.
		tracker.clearRoom('t1');
		expect(tracker.byRoom).toEqual({ general: 1 });
		tracker.dispose();
	});
});
