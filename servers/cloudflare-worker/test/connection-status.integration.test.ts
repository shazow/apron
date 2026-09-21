import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store } from '../src/store';

const headers = { Origin: 'http://localhost:5173', 'CF-Connecting-IP': '198.18.7.1' };

it('exposes daily exhaustion and Retry-After to browsers without spending SQL or admitting sockets', async () => {
	const stub = env.DEMO.getByName('public-demo-v1');
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec('UPDATE resource_budgets SET foreground_writes = 60000, writes_reserved = 60000');
	});
	await evictDurableObject(stub);
	const before = await runInDurableObject(stub, (_instance, state) =>
		state.storage.sql.exec('SELECT * FROM resource_budgets').toArray());
	for (const path of ['/', '/ws']) {
		const response = await SELF.fetch(`https://demo.test${path}?apron_connection_status=1`, { headers });
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: 'Daily demo capacity reached' });
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const retry = Number(response.headers.get('Retry-After'));
		expect(Math.abs(retry - (86400 - Date.now() % 86400000 / 1000))).toBeLessThan(3);
	}
	await runInDurableObject(stub, (_instance, state) => {
		expect(state.storage.sql.exec('SELECT * FROM resource_budgets').toArray()).toEqual(before);
		expect(state.getWebSockets()).toHaveLength(0);
	});
	const upgrade = await SELF.fetch('https://demo.test/ws', { headers: { ...headers, Upgrade: 'websocket' } });
	expect(upgrade.status).toBe(429);
	expect(await upgrade.json()).toEqual({ error: 'Daily demo capacity reached' });
});

it('allows an advisory healthy probe without creating a connection', async () => {
	const stub = env.DEMO.getByName('healthy-connection-status');
	const response = await stub.fetch('https://demo.test/ws?apron_connection_status=1', {
		headers: { ...headers, 'X-Apron-Trusted-IP-Key': 'a'.repeat(22) }
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ available: true });
	await runInDurableObject(stub, (_instance, state) => {
		expect(state.getWebSockets()).toHaveLength(0);
	});
});

it('does not keep reporting yesterday\'s exhausted budget after UTC rollover', async () => {
	await runInDurableObject(env.DEMO.getByName('status-rollover'), (_instance, state) => {
		state.storage.sql.exec('UPDATE resource_budgets SET foreground_writes = 60000, writes_reserved = 60000');
		let now = Date.now();
		const store = new Store(state, {}, () => now);
		store.initialize();
		const before = store.storageAccounting();
		expect(() => store.checkConnectionBudget()).toThrow('Demo capacity reached');
		expect(store.storageAccounting()).toEqual(before);
		now += 86400000;
		expect(() => store.checkConnectionBudget()).not.toThrow();
		expect(store.storageAccounting()).toEqual(before);
	});
});

it('keeps origin checks on the diagnostic path', async () => {
	const response = await SELF.fetch('https://demo.test/ws?apron_connection_status=1', {
		headers: { ...headers, Origin: 'https://not-allowed.test' }
	});
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({ error: 'Origin not allowed' });
});
