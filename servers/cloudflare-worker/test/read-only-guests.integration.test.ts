import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

type Frame = { id?: string | null; method?: string; result?: any; error?: any; params?: any };
let nextIp = 1;

const stub = () => env.DEMO.getByName('public-demo-v1');

/** The deployed default: guests only read (vitest.config.ts turns guest posting on for the other suites). */
async function guestsReadOnly(): Promise<void> {
	await runInDurableObject(stub(), (instance) => {
		const server = instance as unknown as { config: { guestPosting: boolean } };
		server.config = { ...server.config, guestPosting: false };
	});
}

async function connect(origin: string | null = 'http://localhost:5173', ip = `203.0.113.${nextIp++}`) {
	const response = await SELF.fetch('https://demo.test/ws', { headers: {
		Upgrade: 'websocket', ...(origin === null ? {} : { Origin: origin }), 'CF-Connecting-IP': ip,
	} });
	expect(response.status).toBe(101);
	const socket = response.webSocket!;
	const frames: Frame[] = [];
	const waiters: ((frame: Frame) => void)[] = [];
	let closed: { code: number; reason: string } | undefined;
	socket.addEventListener('message', (event) => {
		const frame = JSON.parse(String(event.data));
		const waiter = waiters.shift();
		if (waiter) waiter(frame); else frames.push(frame);
	});
	socket.addEventListener('close', (event) => { closed = { code: event.code, reason: event.reason }; });
	socket.accept();
	return {
		send(frame: unknown) { socket.send(JSON.stringify(frame)); },
		next(): Promise<Frame> {
			const frame = frames.shift();
			return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
		},
		closed: () => closed,
		close() { try { socket.close(1000, 'test complete'); } catch { /* closed */ } },
	};
}

type Peer = Awaited<ReturnType<typeof connect>>;

async function until(peer: Peer, match: (frame: Frame) => boolean): Promise<{ frame: Frame; skipped: Frame[] }> {
	const skipped: Frame[] = [];
	for (;;) {
		const frame = await peer.next();
		if (match(frame)) return { frame, skipped };
		skipped.push(frame);
	}
}

async function exchange(peer: Peer, id: string, method: string, params: unknown): Promise<{ frame: Frame; skipped: Frame[] }> {
	peer.send({ id, method, params });
	return until(peer, (frame) => frame.id === id);
}

async function request(peer: Peer, id: string, method: string, params: unknown): Promise<Frame> {
	return (await exchange(peer, id, method, params)).frame;
}

/** Registers a passkey user straight into the store and signs a connection in with a session token. */
async function signedIn(userId: string): Promise<{ peer: Peer; you: { user_id: string; name?: string } }> {
	const token = await runInDurableObject(stub(), async (instance) => {
		const runtime = instance as unknown as {
			store: { registerIdentity(input: Record<string, unknown>): unknown };
			issueSession(userId: string, origin: string, now: number): Promise<string>;
		};
		runtime.store.registerIdentity({
			userId, name: `Name of ${userId}`, userHandle: `handle-${userId}`, now: Date.now(), ipKey: `ip-${userId}`,
			credential: { credentialId: `cred-${userId}`, userId, publicKey: 'AAAA', counter: 0 },
		});
		return runtime.issueSession(userId, 'http://localhost:5173', Date.now());
	});
	const peer = await connect();
	await peer.next();
	const auth = await request(peer, 'auth', 'auth', { scheme: 'token', token });
	expect(auth.result.you.user_id).toBe(userId);
	return { peer, you: auth.result.you };
}

/** Runs `/invite-bot` and returns the token from the private notice that answers it. */
async function inviteBot(peer: Peer, id: string): Promise<{ token: string; notice: Frame; skipped: Frame[] }> {
	const { frame, skipped } = await exchange(peer, id, 'command', { room_id: 'general', body: { text: '/invite-bot' } });
	expect(frame.result).toEqual({});
	const notice = skipped.find((candidate) => candidate.method === 'message' && candidate.params.from.user_id === '@private');
	expect(notice).toBeDefined();
	const token = /```\n(apron_bot_[A-Za-z0-9_-]+)\n```/.exec(notice!.params.body.text)?.[1];
	expect(token).toBeDefined();
	return { token: token!, notice: notice!, skipped };
}

it('tells a guest it only reads, then denies its writes, joins and leaves included, but not its reads', async () => {
	await guestsReadOnly();
	const guest = await connect();
	try {
		const server = await guest.next();
		expect(server.params.ext.demo.guest_posting).toBe(false);
		// A welcome follows the server frame, before any auth (Appendix B):
		// transient (§3.5), with no room_id since the client knows no rooms yet.
		const welcome = await guest.next();
		expect(welcome.method).toBe('message');
		expect(welcome.params.from.user_id).toBe('@private');
		expect(welcome.params.room_id).toBeUndefined();
		expect(welcome.params.message_id).toBeUndefined();
		expect(welcome.params.body.text).toMatch(/Sign in with a passkey/);
		guest.send({ id: 'auth', method: 'auth', params: { scheme: 'guest' } });
		const auth = await guest.next();
		expect(auth.id).toBe('auth');
		expect(auth.result.you.user_id).toMatch(/^guest_/);

		const denied = (frame: Frame) => {
			expect(frame.error.code).toBe(-32001);
			expect(frame.error.message).toMatch(/sign in/i);
		};
		denied(await request(guest, 'post', 'message', { room_id: 'general', body: { text: 'hello' } }));
		denied(await request(guest, 'post-default', 'message', { body: { text: 'hello' } }));
		denied(await request(guest, 'thread', 'room_set', { parent_room_id: 'general', title: 'Nope' }));
		denied(await request(guest, 'bot', 'command', { body: { text: '/invite-bot' } }));
		// Joining and leaving are writes too: the guest stays in general, where auth put it.
		denied(await request(guest, 'leave', 'room_leave', { room_id: 'general' }));
		denied(await request(guest, 'rejoin', 'room_join', { room_id: 'general' }));

		// Reading stays open: listing, history, and /help.
		expect((await request(guest, 'rooms', 'room_list', { filter: 'joined' })).result.joined[0].room_id).toBe('general');
		expect((await request(guest, 'history', 'history', { room_id: 'general' })).result.latest_log_id).toBeDefined();
		const help = await exchange(guest, 'help', 'command', { body: { text: '/help' } });
		expect(help.frame.result).toEqual({});
		const listed = help.skipped.find((frame) => frame.method === 'message')!.params.body.text;
		expect(listed).toContain('/help');
		expect(listed).not.toContain('/invite-bot');

		// Something to react to and a thread to read, from a registered user.
		const { peer: owner } = await signedIn('reader_owner');
		try {
			const posted = await request(owner, 'post', 'message', { room_id: 'general', body: { text: 'for the guest' } });
			denied(await request(guest, 'react', 'reactions', { message_id: posted.result.message_id, emojis: ['👍'] }));
			const thread = (await request(owner, 'thread', 'room_set', { parent_room_id: 'general', title: 'Readable' })).result.room_id;
			await request(owner, 'reply', 'message', { room_id: thread, body: { text: 'in the thread' } });
			// The guest lists the thread and reads its history without joining it, but cannot join it.
			const threads = await request(guest, 'threads', 'room_list', { parent_room_id: 'general', filter: 'not_joined' });
			expect(threads.result.not_joined.map((room: { room_id: string }) => room.room_id)).toContain(thread);
			const page = await request(guest, 'thread-history', 'history', { room_id: thread });
			expect(page.result.messages.map((message: { body: { text: string } }) => message.body.text)).toContain('in the thread');
			denied(await request(guest, 'join-thread', 'room_join', { room_id: thread }));
		} finally { owner.close(); }
	} finally { guest.close(); }
});

it('lets a registered user invite a bot that signs in from anywhere with its token', async () => {
	await guestsReadOnly();
	const { peer: owner, you } = await signedIn('u_owner');
	const bot = await connect(null);
	try {
		const help = await exchange(owner, 'help', 'command', { body: { text: '/help' } });
		expect(help.skipped.find((frame) => frame.method === 'message')!.params.body.text).toContain('/invite-bot');

		const { token, notice, skipped } = await inviteBot(owner, 'invite');
		expect(notice.params.body.text).toContain('**Bot of Name of u_owner**');
		expect(notice.params.body.text).toContain('`bot_u_owner`');
		// The new bot's logged join of general reaches its members, the owner among them.
		const joined = skipped.find((frame) => frame.method === 'membership');
		expect(joined?.params.members).toEqual([{ user: { user_id: 'bot_u_owner', name: 'Bot of Name of u_owner' }, joined: true }]);

		// A bot has no Origin: it is offered `token`, and its token needs none.
		expect((await bot.next()).params.auth).toEqual(['token', 'guest']);
		const auth = await request(bot, 'auth', 'auth', { scheme: 'token', token });
		expect(auth.result).toEqual({ you: { user_id: 'bot_u_owner', name: 'Bot of Name of u_owner' } });
		expect(auth.result.token).toBeUndefined();
		expect((await request(bot, 'rooms', 'room_list', { filter: 'joined' })).result.joined.map((room: { room_id: string }) => room.room_id)).toEqual(['general']);

		// The bot posts like any registered user; its owner receives it.
		const posted = await request(bot, 'post', 'message', { room_id: 'general', body: { text: 'beep' } });
		expect(posted.result.message_id).toBeDefined();
		const delivered = await until(owner, (frame) => frame.method === 'message' && frame.params.message_id === posted.result.message_id);
		expect(delivered.frame.params.from).toEqual({ user_id: 'bot_u_owner', name: 'Bot of Name of u_owner' });

		// A bot keeps its owner's name and cannot invite bots of its own.
		expect((await request(bot, 'rename', 'me', { name: 'Evil' })).error.code).toBe(-32001);
		const botHelp = await exchange(bot, 'bot-help', 'command', { body: { text: '/help' } });
		expect(botHelp.skipped.find((frame) => frame.method === 'message')!.params.body.text).not.toContain('/invite-bot');
		expect((await request(bot, 'bot-invite', 'command', { body: { text: '/invite-bot' } })).error.code).toBe(-32001);
		expect(you.user_id).toBe('u_owner');
	} finally { owner.close(); bot.close(); }
});

it('replaces a bot token on a new invite, signing out the old one, and renames the bot after its owner', async () => {
	await guestsReadOnly();
	const { peer: owner } = await signedIn('u_rotating');
	const first = await connect(null);
	const stale = await connect(null);
	const fresh = await connect(null);
	try {
		const { token: oldToken } = await inviteBot(owner, 'invite-1');
		await first.next();
		expect((await request(first, 'auth', 'auth', { scheme: 'token', token: oldToken })).result.you.user_id).toBe('bot_u_rotating');

		await request(owner, 'rename', 'me', { name: 'Rotated' });
		const { token: newToken, skipped } = await inviteBot(owner, 'invite-2');
		// No second join: the bot exists and only takes the owner's new name.
		expect(skipped.some((frame) => frame.method === 'membership')).toBe(false);
		expect(newToken).not.toBe(oldToken);

		// The connection that used the old token is closed, and the old token no longer signs in.
		await expect.poll(() => first.closed()?.code).toBe(1008);
		await stale.next();
		expect((await request(stale, 'auth', 'auth', { scheme: 'token', token: oldToken })).error.code).toBe(-32001);
		await fresh.next();
		expect((await request(fresh, 'auth', 'auth', { scheme: 'token', token: newToken })).result.you).toEqual({ user_id: 'bot_u_rotating', name: 'Bot of Rotated' });
	} finally { owner.close(); first.close(); stale.close(); fresh.close(); }
});

it('lets a bot send auth and a post together before the server frame, and retry the post without posting twice', async () => {
	await guestsReadOnly();
	const { peer: owner } = await signedIn('u_deployer');
	try {
		const { token } = await inviteBot(owner, 'invite');
		// A deploy hook (Appendix B): both frames at once, without waiting for `server`.
		const post = { room_id: 'general', body: { text: 'Deployed v1.4.2' } };
		const hook = await connect(null);
		hook.send({ id: 'auth', method: 'auth', params: { scheme: 'token', token, client: 'deploy-hook/1.0' } });
		hook.send({ id: 'deploy-7f3a', method: 'message', params: post });
		const server = await hook.next();
		expect(server.method).toBe('server');
		// Guests only read, and a bot has no Origin: its welcome points at the demo's site.
		const welcome = await hook.next();
		expect(welcome.params.body.text).toMatch(/bot token/);
		expect((await hook.next()).result.you.user_id).toBe('bot_u_deployer');
		// The bot joined general when it was made, so its broadcast comes first (§1).
		const posted = (await until(hook, (frame) => frame.id === 'deploy-7f3a')).frame;
		expect(posted.result.message_id).toBeDefined();
		hook.close();
		// The same id and params on a new connection return the original result.
		const retry = await connect(null);
		retry.send({ id: 'auth', method: 'auth', params: { scheme: 'token', token } });
		retry.send({ id: 'deploy-7f3a', method: 'message', params: post });
		expect((await until(retry, (frame) => frame.id === 'deploy-7f3a')).frame.result).toEqual(posted.result);
		const page = await request(owner, 'history', 'history', { room_id: 'general' });
		expect(page.result.messages.filter((message: { body: { text: string } }) => message.body.text === 'Deployed v1.4.2')).toHaveLength(1);
		retry.close();
	} finally { owner.close(); }
});

it('rejects a made-up bot token', async () => {
	await guestsReadOnly();
	const peer = await connect(null);
	try {
		await peer.next();
		const forged = await request(peer, 'forged', 'auth', { scheme: 'token', token: 'apron_bot_not-a-real-token' });
		expect(forged.error.code).toBe(-32001);
		expect(forged.error.message).toMatch(/invite-bot/);
	} finally { peer.close(); }
});
