import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { BOOTSTRAP_ROW_RESERVATION } from '../src/budget';
import { SCHEMA_VERSION, Store } from '../src/store';

// The schema 1 (protocol v2) layout, verbatim from the last v2 release.
const SCHEMA_V1_DDL = `
	  CREATE TABLE IF NOT EXISTS _meta (
	    key TEXT PRIMARY KEY,
	    value TEXT NOT NULL
	  );
	  CREATE TABLE IF NOT EXISTS room_state (
	    room_id TEXT PRIMARY KEY,
	    last_log_id INTEGER NOT NULL,
	    history_floor INTEGER NOT NULL,
	    last_commit_ms INTEGER NOT NULL,
	    metadata_json TEXT NOT NULL
	  );
	  CREATE TABLE IF NOT EXISTS transitions (
	    room_id TEXT NOT NULL,
	    log_id INTEGER NOT NULL,
	    commit_ms INTEGER NOT NULL,
	    message_id TEXT NOT NULL,
	    snapshot_json TEXT NOT NULL,
	    previous_thread_id TEXT,
	    thread_id TEXT,
	    PRIMARY KEY (room_id, log_id)
	  );
	  CREATE INDEX IF NOT EXISTS transitions_retention_idx
	    ON transitions (room_id, commit_ms, log_id);
	  CREATE INDEX IF NOT EXISTS transitions_message_idx
	    ON transitions (room_id, message_id, log_id);
	  CREATE INDEX IF NOT EXISTS transitions_thread_before_idx
	    ON transitions (room_id, previous_thread_id, log_id);
	  CREATE INDEX IF NOT EXISTS transitions_thread_after_idx
	    ON transitions (room_id, thread_id, log_id);
	  CREATE TABLE IF NOT EXISTS messages (
	    room_id TEXT NOT NULL,
	    message_id TEXT NOT NULL,
	    latest_log_id INTEGER NOT NULL,
	    latest_commit_ms INTEGER NOT NULL,
	    snapshot_json TEXT NOT NULL,
	    author_id TEXT NOT NULL,
	    thread_id TEXT,
	    PRIMARY KEY (room_id, message_id)
	  );
	  CREATE INDEX IF NOT EXISTS messages_latest_idx
	    ON messages (room_id, latest_log_id);
	  CREATE TABLE IF NOT EXISTS threads (
	    room_id TEXT NOT NULL,
	    thread_id TEXT NOT NULL,
	    title TEXT,
	    summary TEXT,
	    root_message_id TEXT,
	    created_ms INTEGER NOT NULL,
	    updated_ms INTEGER NOT NULL,
	    PRIMARY KEY (room_id, thread_id)
	  );
	  CREATE TABLE IF NOT EXISTS identities (
	    user_id TEXT PRIMARY KEY,
	    user_handle TEXT NOT NULL,
	    name TEXT NOT NULL,
	    tier TEXT NOT NULL,
	    created_ms INTEGER NOT NULL,
	    updated_ms INTEGER NOT NULL
	  );
	  CREATE TABLE IF NOT EXISTS credentials (
	    credential_id TEXT PRIMARY KEY,
	    user_id TEXT NOT NULL UNIQUE,
	    public_key_json TEXT NOT NULL,
	    sign_count INTEGER NOT NULL,
	    transports_json TEXT,
	    created_ms INTEGER NOT NULL,
	    updated_ms INTEGER NOT NULL
	  );
	  CREATE INDEX IF NOT EXISTS credentials_user_idx ON credentials (user_id);
	  CREATE TABLE IF NOT EXISTS accepted_requests (
	    user_id TEXT NOT NULL,
	    request_id TEXT NOT NULL,
	    digest TEXT NOT NULL,
	    result_json TEXT NOT NULL,
	    transition_json TEXT,
	    expires_ms INTEGER NOT NULL,
	    PRIMARY KEY (user_id, request_id)
	  );
	  CREATE INDEX IF NOT EXISTS accepted_requests_expiry_idx
	    ON accepted_requests (expires_ms);
	  CREATE TABLE IF NOT EXISTS resource_budgets (
	    day TEXT PRIMARY KEY,
	    reads_reserved INTEGER NOT NULL DEFAULT 0,
	    writes_reserved INTEGER NOT NULL DEFAULT 0,
	    frames_reserved INTEGER NOT NULL DEFAULT 0,
	    admissions_reserved INTEGER NOT NULL DEFAULT 0,
	    posts_reserved INTEGER NOT NULL DEFAULT 0,
	    registrations_reserved INTEGER NOT NULL DEFAULT 0,
	    foreground_reads INTEGER NOT NULL DEFAULT 0,
	    foreground_writes INTEGER NOT NULL DEFAULT 0,
	    maintenance_reads INTEGER NOT NULL DEFAULT 0,
	    maintenance_writes INTEGER NOT NULL DEFAULT 0
	  );
	  CREATE TABLE IF NOT EXISTS principal_limits (
	    scope TEXT NOT NULL,
	    principal_key TEXT NOT NULL,
	    post_events_json TEXT NOT NULL DEFAULT '[]',
	    auth_events_json TEXT NOT NULL DEFAULT '[]',
	    history_events_json TEXT NOT NULL DEFAULT '[]',
	    admission_events_json TEXT NOT NULL DEFAULT '[]',
	    day TEXT NOT NULL,
	    posts_day INTEGER NOT NULL DEFAULT 0,
	    registrations_day INTEGER NOT NULL DEFAULT 0,
	    updated_ms INTEGER NOT NULL,
	    PRIMARY KEY (scope, principal_key)
	  );
	  CREATE INDEX IF NOT EXISTS principal_limits_updated_idx
	    ON principal_limits (updated_ms);
	  CREATE TABLE IF NOT EXISTS maintenance (
	    id INTEGER PRIMARY KEY CHECK (id = 1),
	    next_cleanup_ms INTEGER NOT NULL,
	    cleanup_cutoff_ms INTEGER,
	    cleanup_cursor INTEGER,
	    schema_version INTEGER NOT NULL
	  );
`;

type Sql = DurableObjectState['storage']['sql'];

function count(sql: Sql, query: string, ...bindings: unknown[]): number {
	return Number(sql.exec<{ n: number }>(query, ...bindings).one().n);
}

/** Replace the constructor's schema with a populated schema 1 object. */
function seedSchemaV1(state: DurableObjectState, now: number, options: { unsafe?: boolean; transitions?: number } = {}) {
	const sql = state.storage.sql;
	const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
	for (const { name } of tables) sql.exec(`DROP TABLE ${name}`);
	for (const statement of SCHEMA_V1_DDL.split(';')) if (statement.trim()) sql.exec(statement);
	const head = now - 60_000;
	const day = new Date(now).toISOString().slice(0, 10);
	state.storage.transactionSync(() => {
		sql.exec(
			`INSERT INTO _meta (key, value) VALUES ('schema_version', '1'), ('effective_now_ms', ?), ('next_thread_seq', '2'),
			 ('identity_count', '1'), ('thread_count', '2'), ('principal_limit_count', '3'), ('budget_stop_day', ''),
			 ('accounting_unsafe', ?), ('storage_pressure', '0')`,
			String(now - 1_000), options.unsafe ? '1' : '0',
		);
		sql.exec('INSERT INTO room_state (room_id, last_log_id, history_floor, last_commit_ms, metadata_json) VALUES (?, ?, ?, ?, ?)',
			'general', head, head - 10_000, head, JSON.stringify({ name: 'General' }));
		const transitions = options.transitions ?? 600;
		const payload = 'v2 payload '.repeat(180);
		for (let index = 0; index < transitions; index += 1) {
			const logId = head - transitions + 1 + index;
			const thread = index % 3 === 0 ? 't_1' : null;
			const snapshot = JSON.stringify({ message_id: String(logId), from: { user_id: 'legacy' }, body: { text: payload, format: 'markdown' }, ...(thread ? { thread_id: thread } : {}) });
			sql.exec('INSERT INTO transitions (room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id) VALUES (?, ?, ?, ?, ?, NULL, ?)',
				'general', logId, logId, String(logId), snapshot, thread);
			sql.exec('INSERT INTO messages (room_id, message_id, latest_log_id, latest_commit_ms, snapshot_json, author_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
				'general', String(logId), logId, logId, snapshot, 'legacy', thread);
		}
		sql.exec("INSERT INTO threads (room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms) VALUES ('general', 't_1', 'Old', NULL, NULL, ?, ?), ('general', 't_2', NULL, 'Summary', NULL, ?, ?)", head, head, head, head);
		sql.exec("INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES ('user_passkey', 'handle', 'Passkey User', 'registered', ?, ?)", head, head);
		sql.exec("INSERT INTO credentials (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms) VALUES ('cred-1', 'user_passkey', ?, 7, NULL, ?, ?)",
			JSON.stringify({ publicKey: 'public-key' }), head, head);
		sql.exec("INSERT INTO accepted_requests (user_id, request_id, digest, result_json, transition_json, expires_ms) VALUES ('user_passkey', 'old-request', 'digest', ?, NULL, ?)",
			JSON.stringify({ message_id: String(head), __method: 'message' }), now + 3_600_000);
		sql.exec(
			`INSERT INTO resource_budgets (day, reads_reserved, writes_reserved, frames_reserved, admissions_reserved, posts_reserved,
			 registrations_reserved, foreground_reads, foreground_writes, maintenance_reads, maintenance_writes)
			 VALUES (?, 5000, 4000, 30, 3, 20, 1, 4000, 3000, 1000, 1000)`, day);
		for (const key of ['anonymous:ip', 'ip:ip', 'global']) {
			sql.exec(
				`INSERT INTO principal_limits (scope, principal_key, post_events_json, auth_events_json, history_events_json, admission_events_json, day, posts_day, registrations_day, updated_ms)
				 VALUES ('post', ?, ?, '[]', '[]', '[]', ?, 20, 0, ?)`, key, JSON.stringify([now - 5_000]), day, now - 5_000);
		}
		sql.exec('INSERT INTO maintenance (id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version) VALUES (1, ?, ?, ?, 1)', now + 600_000, head - 86_400_000, head - 10_000);
	});
	return { head, day };
}

it('upgrades a protocol v2 object in place, keeping authority and advancing the log past discarded content', async () => {
	const stub = env.DEMO.getByName('migration-v1-upgrade');
	const now = Date.now() + 1_000;
	const result = await runInDurableObject(stub, (_instance, state) => {
		const { head, day } = seedSchemaV1(state, now);
		const sql = state.storage.sql;
		const sizeBefore = sql.databaseSize;
		const store = new Store(state, {}, { now: () => now });
		const before = store.storageAccounting();
		store.initialize();
		const migration = store.storageAccounting();
		const observed = { reads: migration.reads - before.reads, writes: migration.writes - before.writes };
		// The one-time migration fits the same bootstrap reservation as a new object.
		expect(migration.reservedReads - before.reservedReads).toBe(BOOTSTRAP_ROW_RESERVATION);
		expect(observed.reads).toBeLessThanOrEqual(BOOTSTRAP_ROW_RESERVATION);
		expect(observed.writes).toBeLessThanOrEqual(BOOTSTRAP_ROW_RESERVATION);

		const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('transitions', 'messages', 'threads', 'room_state')").toArray();
		expect(tables).toEqual([]);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'").one().value).toBe(String(SCHEMA_VERSION));
		expect(count(sql, "SELECT COUNT(*) AS n FROM _meta WHERE key = 'next_thread_seq'")).toBe(0);
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'thread_count'").one().value).toBe('0');
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'identity_count'").one().value).toBe('1');
		expect(sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = 'principal_limit_count'").one().value).toBe('3');
		expect(sql.exec('SELECT schema_version, cleanup_cursor, cleanup_cutoff_ms, next_cleanup_ms FROM maintenance WHERE id = 1').one())
			.toEqual({ schema_version: SCHEMA_VERSION, cleanup_cursor: null, cleanup_cutoff_ms: null, next_cleanup_ms: now + 600_000 });

		// Every v2 record is discarded; the log continues above the v2 head and
		// the floor moves past everything that was dropped.
		const general = store.getRoomState();
		expect(BigInt(general.log_id)).toBeGreaterThan(BigInt(head));
		expect(general).toEqual({ room_id: 'general', log_id: general.log_id, title: 'General', latest_log_id: general.log_id, history_log_id: general.log_id });
		expect(store.logBounds()).toEqual({ latest_log_id: general.log_id, history_floor: general.log_id });
		expect(store.listRooms()).toEqual([general]);

		// Authority independent of chat content is unchanged.
		expect(store.getIdentity('user_passkey')).toEqual({ userId: 'user_passkey', name: 'Passkey User', userHandle: 'handle', credentialCount: 1 });
		expect(store.getCredential('cred-1')).toMatchObject({ userId: 'user_passkey', publicKey: 'public-key', counter: 7 });
		expect(store.findDedup('user_passkey', 'old-request', now)?.result).toEqual({ message_id: String(head) });
		const budget = store.budget(now);
		expect(budget).toMatchObject({ day, frames: 30, admissions: 3, posts: 20, registrations: 1 });
		expect(budget.maintenance_reads).toBeGreaterThanOrEqual(1_000 + BOOTSTRAP_ROW_RESERVATION);
		expect(count(sql, "SELECT COUNT(*) AS n FROM principal_limits WHERE posts_day = 20")).toBe(3);
		expect(store.accountingStatus().unsafe).toBe(false);

		const posted = store.mutate({
			userId: 'user_passkey', ipKey: 'other-ip', requestId: 'first-v3', method: 'message', now,
			identity: { user_id: 'user_passkey', name: 'Passkey User' }, params: { room_id: 'general', body: { text: 'v3' } },
		});
		expect(BigInt(posted.message!.log_id)).toBeGreaterThan(BigInt(general.log_id));
		return { head, general: general.log_id, observed, sizeBefore, sizeAfter: sql.databaseSize };
	});
	console.info('migration-v1-upgrade', JSON.stringify(result));

	// A wake after the upgrade does not rerun the migration or rewrite schema.
	await evictDurableObject(stub);
	await runInDurableObject(stub, (_instance, state) => {
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		expect(store.storageAccounting().writes).toBe(0);
		expect(store.getRoomState().log_id).toBe(result.general);
	});
});

it('keeps a persisted accounting stop across the upgrade', async () => {
	await runInDurableObject(env.DEMO.getByName('migration-v1-unsafe'), (_instance, state) => {
		const now = Date.now() + 1_000;
		seedSchemaV1(state, now, { unsafe: true, transitions: 3 });
		const store = new Store(state, {}, { now: () => now });
		store.initialize();
		expect(store.accountingStatus().unsafe).toBe(true);
		expect(() => store.getRoomState()).toThrow('storage accounting is unsafe');
	});
});
