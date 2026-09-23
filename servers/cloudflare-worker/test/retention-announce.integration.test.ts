import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };

async function connect(ip: string) {
	const response = await SELF.fetch('https://demo.test/ws', { headers: { Upgrade: 'websocket', Origin: 'http://localhost:5173', 'CF-Connecting-IP': ip } });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const waiters: ((frame: Frame) => void)[] = [];
	socket.addEventListener('message', event => {
		const frame = JSON.parse(String(event.data));
		const waiter = waiters.shift();
		if (waiter) waiter(frame); else frames.push(frame);
	});
	socket.accept();
	const next = (): Promise<Frame> => frames.length ? Promise.resolve(frames.shift()!) : new Promise(resolve => waiters.push(resolve));
	return { socket, next, send: (frame: unknown) => socket.send(JSON.stringify(frame)) };
}

it('announces committed thread-room removals even when the room listing fails', async () => {
	const peer = await connect('192.0.2.77');
	try {
		expect((await peer.next()).method).toBe('server');
		peer.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		expect((await peer.next()).id).toBe('auth');
		expect((await peer.next()).params.room_id).toBe('general');
		peer.send({ id: 'thread', method: 'room', params: { parent_room_id: 'general', title: 'Short-lived' } });
		const roomId = (await peer.next()).result.room_id;
		expect((await peer.next()).params.room_id).toBe(roomId);

		await runInDurableObject(env.DEMO.getByName('public-demo-v1'), async (instance, state) => {
			// Age every record past retention and make cleanup due now.
			state.storage.sql.exec('UPDATE records SET commit_ms = 0');
			state.storage.sql.exec('UPDATE maintenance SET next_cleanup_ms = 0, cleanup_cursor = NULL, cleanup_cutoff_ms = NULL WHERE id = 1');
			// Simulate an exhausted budget for the re-announcement listing.
			const runtime = instance as unknown as { store: { listRooms: () => never }; alarm(): Promise<void> };
			runtime.store.listRooms = () => { throw new Error('listing unavailable'); };
			await runtime.alarm();
		});
		expect(await peer.next()).toEqual({ method: 'room', params: { room_id: roomId, removed: true } });
	} finally { peer.socket.close(1000, 'done'); }
});
