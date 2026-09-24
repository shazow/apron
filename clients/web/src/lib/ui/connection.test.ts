import { describe, expect, it } from 'vitest';
import { capabilitiesOf, type ClientSnapshot } from '$lib/protocol/client';
import { connectionStateOf, demoRetentionNotice, statusLabel } from './connection';
import { retryAfterLabel } from './time';

const snapshot = (fields: Partial<ClientSnapshot>): ClientSnapshot => ({
	status: 'idle', authenticated: false, capabilities: capabilitiesOf(undefined), rooms: [], pending: [], typing: [], users: {}, userAliases: {}, uploads: {}, threadDirectory: {}, showReconnectDivider: false, ...fields
});

describe('connection state', () => {
	it('is connected only once auth has landed an identity', () => {
		expect(connectionStateOf(snapshot({ status: 'connected' }))).toBe('connecting');
		expect(connectionStateOf(snapshot({ status: 'connected', authenticated: true, you: { user_id: 'a' } }))).toBe('connected');
		expect(connectionStateOf(snapshot({ status: 'connected', disconnectedAt: 1 }))).toBe('reconnecting');
		expect(connectionStateOf(snapshot({ status: 'offline' }))).toBe('offline');
	});

	it('says what happened, then what the client is doing', () => {
		expect(statusLabel(snapshot({ status: 'reconnecting', disconnectedAt: 1 }), false)).toBe('Reconnecting…');
		expect(statusLabel(snapshot({ status: 'reconnecting', disconnectedAt: 1 }), true)).toBe('Still trying to reconnect…');
		expect(statusLabel(snapshot({ status: 'reconnecting', disconnectedAt: 1, error: 'WebSocket connection error' }), false)).toBe('Reconnecting…');
		expect(statusLabel(snapshot({ status: 'reconnecting', disconnectedAt: 1, error: 'Refused' }), true)).toBe('Still disconnected: Refused');
		expect(statusLabel(snapshot({ status: 'reconnecting', disconnectedAt: 1, retryAfterMs: 90_000 }), false)).toBe('Connection limited. Retrying in 2m…');
		expect(statusLabel(snapshot({ status: 'connecting' }), false)).toBe('Connecting…');
		expect(statusLabel(snapshot({ status: 'idle' }), false)).toBe('Waiting to connect');
	});

	it('rounds retry delays up to a readable unit', () => {
		expect(retryAfterLabel(500)).toBe('1s');
		expect(retryAfterLabel(59_000)).toBe('59s');
		expect(retryAfterLabel(61_000)).toBe('2m');
		expect(retryAfterLabel(3_600_000)).toBe('1h');
	});

	it('describes demo retention in hours, or a day', () => {
		expect(demoRetentionNotice(undefined)).toBe('');
		expect(demoRetentionNotice({ protocol: 4, auth: [], ext: { demo: { retention_seconds: 86_400 } } })).toMatch(/last day/);
		expect(demoRetentionNotice({ protocol: 4, auth: [], ext: { demo: { retention_seconds: 7_200 } } })).toMatch(/last 2 hours/);
		expect(demoRetentionNotice({ protocol: 4, auth: [], ext: {} })).toBe('');
	});
});
