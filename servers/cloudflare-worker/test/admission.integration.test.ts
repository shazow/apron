import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ADMISSION_BUDGET } from '../src/budget';
import { fetchEntry } from '../src/index';

function upgrade(ip: string, path = '/') {
	return new Request(`https://demo.test${path}`, {
		headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip },
	});
}

// Use the real runtime limiter with no DO capability. Responses prove that
// rejection works even when contacting a Durable Object is impossible.
function withoutObject(extra: Partial<Env> = {}): Env {
	return { ...env, ALLOWED_ORIGINS: '*', DEMO: undefined, ...extra } as unknown as Env;
}

it('stops admission before the DO and before spending an attempt', async () => {
	const ip = '198.18.1.1';
	for (let i = 0; i <= ADMISSION_BUDGET.requestsPerIpMinute; i++) {
		const response = await fetchEntry(upgrade(ip), withoutObject({ ADMISSION_OFF: 'true' }));
		expect(response.status).toBe(503);
		expect(await response.text()).toContain('Demo admission is closed');
	}
	const reopened = await fetchEntry(upgrade(ip), withoutObject());
	expect(await reopened.text()).toContain('Demo capacity unavailable');
});

it('rejects excess attempts before requiring a DO binding and shares the two paths', async () => {
	const ip = '198.18.1.2';
	for (let i = 0; i < ADMISSION_BUDGET.requestsPerIpMinute; i++) {
		const response = await fetchEntry(upgrade(ip, i % 2 ? '/' : '/ws'), withoutObject());
		expect(await response.text()).toContain('Demo capacity unavailable');
	}
	const denied = await fetchEntry(upgrade(ip), withoutObject());
	expect(denied.status).toBe(429);
	expect(denied.headers.get('Retry-After')).toBe(String(ADMISSION_BUDGET.workerWindowSeconds));
	expect(await denied.text()).toContain('Connection attempts exceeded');
	const other = await fetchEntry(upgrade('198.18.1.3'), withoutObject());
	expect(await other.text()).toContain('Demo capacity unavailable');
});

it('groups IPv6 attempts by /64, ignoring supplied internal keys', async () => {
	for (let i = 0; i < ADMISSION_BUDGET.requestsPerIpMinute; i++) {
		const request = upgrade(`2001:db8:feed:1234::${i + 1}`);
		request.headers.set('X-Apron-Trusted-IP-Key', `forged-${i}`);
		expect(await (await fetchEntry(request, withoutObject())).text()).toContain('Demo capacity unavailable');
	}
	expect((await fetchEntry(upgrade('2001:db8:feed:1234::ffff'), withoutObject())).status).toBe(429);
	expect(await (await fetchEntry(upgrade('2001:db8:feed:1235::1'), withoutObject())).text()).toContain('Demo capacity unavailable');
});

it('fails closed when the limiter binding is missing', async () => {
	const response = await fetchEntry(upgrade('198.18.1.4'), withoutObject({ CONNECTION_ATTEMPTS: undefined }));
	expect(response.status).toBe(503);
	expect(await response.text()).toContain('Demo admission unavailable');
});

it('rejects malformed upgrades without consuming valid connection attempts', async () => {
	const ip = '198.18.1.5';
	for (let i = 0; i <= ADMISSION_BUDGET.requestsPerIpMinute; i++) {
		const invalid = new Request('https://demo.test/ws', { headers: { 'CF-Connecting-IP': ip } });
		expect((await fetchEntry(invalid, withoutObject())).status).toBe(400);
	}
	expect(await (await fetchEntry(upgrade(ip), withoutObject())).text()).toContain('Demo capacity unavailable');
});
