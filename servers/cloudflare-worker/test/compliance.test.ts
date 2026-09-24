import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_LIMITS, isAllowedOrigin, loadConfig } from '../src/config';
import { canonicalizeIp, extractClientIp, hashIpKey } from '../src/ip';
import { DEFAULT_PARSE_OPTIONS, FrameError, parseFrame } from '../src/protocol';

// Independent boundary cases from the implementation specification.
describe('trusted IP boundaries', () => {
	it('keeps compact rate-limit keys stable and preserves address grouping', async () => {
		const hash = (address: string) => hashIpKey(canonicalizeIp(address)!);
		// Pin the persisted format so a refactor cannot silently reset IP quotas.
		expect(await hash('192.0.2.10')).toBe('zBXK6QD6CozD5FPoI5CPlQ');
		expect(await hash('::ffff:192.0.2.10')).toBe(await hash('192.0.2.10'));
		expect(await hash('192.0.2.11')).not.toBe(await hash('192.0.2.10'));
		expect(await hash('2001:db8:1:2::1')).toBe(await hash('2001:db8:1:2::abcd'));
		expect(await hash('2001:db8:1:3::1')).not.toBe(await hash('2001:db8:1:2::1'));
	});
	it('joins dotted and hexadecimal IPv4-mapped IPv6 with IPv4', () => {
		const key = canonicalizeIp('192.0.2.10')?.key;
		expect(canonicalizeIp('::ffff:192.0.2.10')?.key).toBe(key);
		expect(canonicalizeIp('0:0:0:0:0:ffff:c000:020a')?.key).toBe(key);
		expect(canonicalizeIp('2001:db8:1:2::1')?.key).toBe(canonicalizeIp('2001:0db8:0001:0002:abcd::5')?.key);
		expect(canonicalizeIp('2001:db8:1:3::1')?.key).not.toBe(canonicalizeIp('2001:db8:1:2::1')?.key);
	});
	it('does not let an unrelated IPv6 header change a real IPv4 principal', () => {
		const headers = new Headers({ 'CF-Connecting-IP': '192.0.2.10', 'CF-Connecting-IPv6': '2001:db8::1' });
		expect(extractClientIp(headers)?.key).toBe(canonicalizeIp('192.0.2.10')?.key);
	});
	it('uses the real IPv6 address for pseudo IPv4 and fails without it', () => {
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '240.1.2.3' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '240.1.2.3', 'CF-Connecting-IPv6': '2001:db8::1' }))?.key)
			.toBe(canonicalizeIp('2001:db8::2')?.key);
	});
	it('rejects absent metadata and the cross-zone Worker sentinel', () => {
		expect(extractClientIp(new Headers({ 'X-Forwarded-For': '192.0.2.1' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IPv6': '2001:db8::1' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '192.0.2.1', 'CF-Worker': 'example.test' }))).toBeNull();
		expect(extractClientIp(new Headers({ 'CF-Connecting-IP': '2a06:98c0:3600::103' }))).toBeNull();
	});
});

describe('frame policy boundaries', () => {
	it('counts depth by containers and nodes by values', () => {
		const options = { ...DEFAULT_PARSE_OPTIONS, maxJsonDepth: 2 };
		expect(parseFrame(JSON.stringify({ id: 'a', method: 'auth', params: { scheme: 'guest' } }), options).request.id).toBe('a');
		expect(() => parseFrame(JSON.stringify({ id: 'a', method: 'auth', params: { nested: {} } }), options)).toThrow(FrameError);
	});
	it('preserves identifiable IDs on structural policy errors', () => {
		try {
			parseFrame(JSON.stringify({ id: 'bounded', method: 'message', params: { a: 1, b: 2 } }), {
				...DEFAULT_PARSE_OPTIONS, maxJsonNodes: 4
			});
			expect.unreachable('expected structural rejection');
		} catch (error) {
			expect(error).toBeInstanceOf(FrameError);
			expect((error as FrameError).id).toBe('bounded');
		}
	});
	it('bounds raw UTF-8 bytes before parsing and rejects binary', () => {
		expect(() => parseFrame('"' + 'é'.repeat(8192) + '"')).toThrow(FrameError);
		try { parseFrame(new ArrayBuffer(0)); }
		catch (error) { expect((error as FrameError).closeCode).toBe(1003); }
	});
	it('accepts empty string IDs and both envelopes without treating unknown fields as operations', () => {
		expect(parseFrame('{"id":"","method":"auth","params":{},"ignored":42}').request.id).toBe('');
		expect(parseFrame('{"jsonrpc":"2.0","id":"a","method":"auth"}').request.full).toBe(true);
		expect(parseFrame('{"method":"unknown"}').request.id).toBeUndefined();
	});
});

describe('configuration policy boundaries', () => {
	const base = {
		NODE_ENV: 'test',
	} as Parameters<typeof loadConfig>[0];

	function config(extra: Record<string, string> = {}, overrides: Partial<typeof DEFAULT_LIMITS> = {}) {
		return loadConfig({ ...base, ...extra } as Parameters<typeof loadConfig>[0], overrides);
	}

	it('accepts the documented aliases in prefixed precedence order', () => {
		const loaded = config({
			LIMIT_HISTORY_MAX_LIMIT: '49',
			HISTORY_MAX_LIMIT: '48',
			historyMaxLimit: '47',
		});
		expect(loaded.limits.historyMaxLimit).toBe(49);
	});

	it('rejects unsafe payload, queue, history, and maintenance combinations', () => {
		expect(() => config({}, { historyMaxLimit: 51 })).toThrow(ConfigError);
		expect(() => config({}, { maxTextBytes: 4_097 })).toThrow(ConfigError);
		expect(() => config({}, { pendingFramesPerConnection: 9 })).toThrow(ConfigError);
		expect(() => config({}, { pendingBytesPerConnection: DEFAULT_LIMITS.maxFrameBytes - 1 })).toThrow(ConfigError);
		expect(() => config({}, { historyMaxResponseBytes: DEFAULT_LIMITS.maxSnapshotBytes + 511 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceReadsPerDay: 8 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceWritesPerDay: 8 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceReadsPerDay: 519 })).toThrow(ConfigError);
		expect(() => config({}, { maintenanceWritesPerDay: 519 })).toThrow(ConfigError);
		expect(config({}, { maintenanceReadsPerDay: 520, maintenanceWritesPerDay: 520 }).limits.maintenanceReadsPerDay).toBe(520);
	});

	it('bounds reaction sets so a moved message fits one history response', () => {
		expect(config({ REACTION_USERS_PER_MESSAGE: '64', REACTION_EMOJIS_PER_USER: '16' }).limits.reactionUsersPerMessage).toBe(64);
		expect(() => config({}, { reactionUsersPerMessage: 65 })).toThrow(ConfigError);
		expect(() => config({}, { reactionEmojisPerUser: 17 })).toThrow(ConfigError);
		expect(() => config({}, { reactionUsersPerMessage: 64, historyMaxResponseBytes: 64 * 1024 })).toThrow(ConfigError);
	});

	it('rejects resource ceilings and per-scope counter inversions', () => {
		expect(() => config({}, { databaseHighWaterBytes: 97 * 1024 * 1024 })).toThrow(ConfigError);
		expect(() => config({}, { framesPerConnectionMinute: 61, framesPerIpMinute: 60 })).toThrow(ConfigError);
		expect(() => config({}, { openConnections: 11, connectionsPerIp: 12 })).toThrow(ConfigError);
		expect(() => config({}, { registrationsPerDay: 101 })).toThrow(ConfigError);
	});

	it('keeps activity off unless ACTIVITY is true, and bounds the server-wide frame minute', () => {
		expect(config().activityEnabled).toBe(false);
		expect(config({ ACTIVITY: 'true' }).activityEnabled).toBe(true);
		expect(() => config({ ACTIVITY: 'maybe' })).toThrow(ConfigError);
		expect(config().limits.globalFramesPerMinute).toBe(300);
		expect(() => config({}, { globalFramesPerMinute: DEFAULT_LIMITS.framesPerIpMinute - 1 })).toThrow(ConfigError);
		expect(() => config({}, { globalFramesPerMinute: 1_001 })).toThrow(ConfigError);
		expect(config().limits.frameLease).toBe(10);
		expect(() => config({}, { frameLease: 21 })).toThrow(ConfigError);
		expect(() => config({}, { frameLease: 20, framesPerIpMinute: 39 })).toThrow(ConfigError);
	});

	it('allows arbitrary guest origins with an explicit passkey allowlist', () => {
		const open = config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: 'https://web.apron.chat', RP_ID: 'apron.chat' });
		for (const origin of ['http://localhost:1234', 'http://127.0.0.1:9876', 'http://[::1]:3000', 'http://192.168.1.2:8080', 'https://custom.example', 'null', null]) {
			expect(isAllowedOrigin(open, origin)).toBe(true);
		}
		expect(open.rpOrigins).toEqual(['https://web.apron.chat']);
		expect(() => config({ ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: '*' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*,http://localhost:5173', RP_ORIGINS: 'http://localhost:5173' })).toThrow(ConfigError);
		expect(() => config({ ALLOWED_ORIGINS: '*', RP_ORIGINS: 'https://unrelated.example', RP_ID: 'apron.chat' })).toThrow(ConfigError);
		const restricted = config();
		expect(isAllowedOrigin(restricted, 'http://localhost:5173')).toBe(true);
		expect(isAllowedOrigin(restricted, null)).toBe(true);
		expect(isAllowedOrigin(restricted, 'https://custom.example')).toBe(false);
		expect(isAllowedOrigin(restricted, 'null')).toBe(false);
	});

	it('requires exact origins and bounds the browser display name', () => {
		expect(() => loadConfig({})).toThrow(ConfigError);
		expect(config({ ENVIRONMENT: 'development' }).allowedOrigins).toEqual([
			'http://localhost:5173',
			'http://localhost:8787',
		]);
		expect(() => config({
			ALLOWED_ORIGINS: 'https://chat.example.test/',
			RP_ORIGINS: 'https://chat.example.test/',
			RP_ID: 'example.test',
		})).toThrow(ConfigError);
		expect(() => config({
			ALLOWED_ORIGINS: 'https://chat.example.test',
			RP_ORIGINS: 'https://other.example.test',
			RP_ID: 'example.test',
		})).toThrow(ConfigError);
		expect(() => config({ RP_NAME: 'x'.repeat(DEFAULT_LIMITS.maxNameCodePoints + 1) })).toThrow(ConfigError);
	});
});
