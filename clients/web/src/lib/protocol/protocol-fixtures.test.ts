import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import historyFixture from '../../../../../tests/fixtures/history.json';
import webAuthn from '../../../../../tests/fixtures/webauthn.json';
import { ChatClient, type ClientSnapshot } from './client';
import { FakeSocket, settle } from './fake-socket';
import { compareLogIds } from './reducer';
import { passkeyPublicKeyOptions } from './webauthn';
import { isLogId } from './types';

type HistoryCase = (typeof historyFixture.cases)[number];

describe('Base history fixtures', () => {
	it('uses nullable room-wide boundaries and includes both bounds on history results', () => {
		expect(historyFixture.format).toBe(3);
		expect(historyFixture.kind).toBe('history');
		for (const scenario of historyFixture.cases) {
			if (!scenario.room) continue;
			const roomParams = scenario.room;
			expect(isLogId(roomParams.latest_log_id)).toBe(true);
			expect(isLogId(roomParams.log_id)).toBe(true);
			expect(Object.hasOwn(roomParams, 'history_log_id')).toBe(true);
			if (roomParams.history_log_id !== null) expect(isLogId(roomParams.history_log_id)).toBe(true);

			if (!scenario.history) continue;
			const result = scenario.history.result;
			expect(result.latest_log_id).toBe(roomParams.latest_log_id);
			expect(Object.hasOwn(result, 'history_log_id')).toBe(true);
			if (result.history_log_id !== null) expect(isLogId(result.history_log_id)).toBe(true);
			for (const entry of result.entries) expect(entry).toHaveProperty('log_id');
		}
	});

	it('derives forward recovery from the checkpoint and the lower bound', () => {
		for (const scenario of historyFixture.cases) {
			if (!('checkpoint' in scenario) || !scenario.checkpoint || !scenario.floor) continue;
			const next = String(BigInt(scenario.checkpoint) + 1n);
			const after = compareLogIds(next, scenario.floor) >= 0 ? next : scenario.floor;
			expect(after, scenario.name).toBe(scenario.assertions.forward_recovery_after);
			expect(compareLogIds(next, scenario.floor) < 0, scenario.name).toBe(scenario.assertions.restart);
		}
	});
});

describe('history fixtures through the client', () => {
	let client: ChatClient;
	let snapshot: ClientSnapshot;

	beforeEach(() => {
		vi.useFakeTimers();
		FakeSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeSocket);
		client = new ChatClient('ws://fake.test/');
		client.subscribe((next) => (snapshot = next));
		client.start();
	});

	afterEach(() => {
		client.stop();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const scenario = (name: string): HistoryCase => historyFixture.cases.find((entry) => entry.name === name)!;

	it('needs no request when history was discarded', async () => {
		const { room, assertions } = scenario('discarded-history');
		await FakeSocket.latest().greet(['history'], { room: room! });
		expect(FakeSocket.latest().sent.some((frame) => frame.method === 'history')).toBe(false);
		const general = snapshot.rooms[0];
		expect(general.historyLogId).toBe(assertions.history_log_id);
		expect(general.latestLogId).toBe(assertions.latest_log_id);
		expect(general.timeline.order).toEqual([]);
		expect(general.loaded).toBe(true);
	});

	it('pages from the inclusive lower bound and keeps an empty result empty', async () => {
		const { room, history, assertions } = scenario('empty-page-retains-room-boundary');
		const socket = FakeSocket.latest();
		await socket.greet(['history'], { room: room! });
		expect(socket.request('history').params).toMatchObject({ room_id: 'general', after: assertions.effective_lower_bound, before: assertions.latest_log_id });
		await socket.reply('history', history!.result);
		expect(snapshot.rooms[0].timeline.order).toEqual([]);
		expect(snapshot.rooms[0].recovering).toBe(false);
	});

	it('keeps an old message ID whose latest snapshot is retained and drops expired ones', async () => {
		const { room, entries, history, assertions } = scenario('floor-advances-with-old-message-id-retained');
		const socket = FakeSocket.latest();
		await socket.greet(['history'], { room: { ...room!, history_log_id: '700', latest_log_id: '812' } });
		// Live snapshots from before retention advanced.
		for (const entry of entries!) socket.receive({ method: 'message', params: entry });
		await socket.reply('history', { entries: [], more: false, latest_log_id: '812', history_log_id: '700' });
		expect(snapshot.rooms[0].timeline.order).toEqual(['700', '710']);
		socket.receive({ method: 'room_update', params: { updated: [room!] } });
		await socket.reply('history', history!.result);
		const timeline = snapshot.rooms[0].timeline;
		expect(timeline.order).toEqual(assertions.retained_message_ids);
		expect(timeline.events['700'].body?.text).toBe('recent edit');
		expect(timeline.reactions['700']?.map((entry) => entry.emoji)).toEqual(['👍']);
		for (const log of assertions.discarded_log_ids ?? []) {
			expect(Object.values(timeline.events).some((event) => event.log_id === log)).toBe(false);
		}
		await settle();
	});
});

describe('Base WebAuthn fixtures', () => {
	it('uses canonical public_key options and two-step actions', () => {
		expect(webAuthn.format).toBe(1);
		expect(webAuthn.kind).toBe('webauthn');
		const registration = webAuthn.cases[0];
		const options = passkeyPublicKeyOptions(registration.begin_result);
		expect(options).toEqual(registration.begin_result.public_key);
		expect(options?.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required' });
		expect(registration.finish?.params.credential.id).toBe(registration.finish?.params.credential.rawId);
		expect(registration.begin.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'begin' });
		expect(registration.finish?.params).toMatchObject({ scheme: 'webauthn', action: 'register', step: 'finish', challenge_id: registration.begin_result.challenge_id });
	});
});
