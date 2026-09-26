import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Peer = { socket: WebSocket; next(): Promise<any> };

it('bounds admission at 100 live sockets and delivers one ordered maximum fan-out', async () => {
	const peers: Peer[] = [];
	try {
		for (let index = 1; index <= 100; index++) {
			const response = await SELF.fetch('https://capacity.test/ws', { headers: {
				Upgrade: 'websocket', 'CF-Connecting-IP': `198.51.100.${index}`,
			} });
			expect(response.status).toBe(101);
			const socket = response.webSocket!;
			const buffered: any[] = [];
			const waiters: ((value: any) => void)[] = [];
			socket.addEventListener('message', event => {
				const frame = JSON.parse(String(event.data));
				const waiter = waiters.shift();
				if (waiter) waiter(frame); else buffered.push(frame);
			});
			socket.accept();
			const peer = { socket, next: () => buffered.length ? Promise.resolve(buffered.shift()) : new Promise(resolve => waiters.push(resolve)) };
			peers.push(peer);
			expect((await peer.next()).method).toBe('server');
			socket.send(JSON.stringify({ id: 'auth', method: 'auth', params: { scheme: 'guest' } }));
			expect((await peer.next()).result.you.user_id).toBeTruthy();
		}
		const rejected = await SELF.fetch('https://capacity.test/ws', { headers: {
			Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.101',
		} });
		expect(rejected.status).toBe(429);
		const text = 'x'.repeat(4096);
		peers[0].socket.send(JSON.stringify({ id: 'fanout', method: 'message', params: { room_id: 'general', body: { text } } }));
		// Every member gets the broadcast; the sender's comes before its result (§1).
		const frames = await Promise.all(peers.map(peer => peer.next()));
		const reply = await peers[0].next();
		expect(reply.id).toBe('fanout');
		expect(reply.result.message_id).toBeTruthy();
		for (const frame of frames) {
			expect(frame.method).toBe('message');
			expect(frame.params.body.text).toBe(text);
			expect(frame.params.message_id).toBe(reply.result.message_id);
			expect(frame.params.log_id).toBe(frames[0].params.log_id);
		}
	} finally {
		for (const peer of peers) peer.socket.close(1000, 'capacity test complete');
	}
}, 30_000);
