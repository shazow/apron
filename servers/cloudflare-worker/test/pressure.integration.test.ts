import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { Store, StoreError, defaultStoreConfig } from '../src/store';

const MIB = 1024 * 1024;
const SNAPSHOT_BYTES = 8 * 1024;
const INSERT_CHUNK = 64;
const MAX_CALIBRATION_ROWS = 20_000;

type CalibrationSql = {
	databaseSize: number;
	exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): {
		one(): T;
		toArray(): T[];
	};
};

function retryAfter(error: unknown): asserts error is StoreError {
	expect(error).toBeInstanceOf(StoreError);
	expect((error as StoreError).code).toBe('retry_after');
}

function insertCalibrationRows(
	sql: CalibrationSql,
	payload: string,
	start: number,
	end: number,
	transactionSync?: (callback: () => void) => void,
): void {
	if (end < start) return;
	for (let chunkStart = start; chunkStart <= end; chunkStart += INSERT_CHUNK) {
		const chunkEnd = Math.min(end, chunkStart + INSERT_CHUNK - 1);
		// Keep each local calibration transaction bounded. This table is test
		// data only; it is deliberately outside Store's request accounting.
		const insertChunk = () => {
				for (let id = chunkStart; id <= chunkEnd; id += 1) {
					sql.exec('INSERT INTO pressure_calibration (id, snapshot_json) VALUES (?, ?)', id, payload);
				}
		};
		if (transactionSync) {
			transactionSync(insertChunk);
		} else {
			insertChunk();
		}
	}
}

function deleteUntilBelow(sql: CalibrationSql, target: number, rows: number): number {
	let keep = rows;
	for (let iteration = 0; iteration < 128 && sql.databaseSize > target && keep > 1; iteration += 1) {
		// Small bounded decrements keep the 90 MiB checkpoint above low-water;
		// a single large delete can free several MiB of pages at once.
		const nextKeep = Math.max(1, Math.floor(keep * 0.98));
		sql.exec('DELETE FROM pressure_calibration WHERE id > ?', nextKeep).toArray();
		keep = nextKeep;
	}
	return keep;
}

function pressureMessage(now: number, requestId: string) {
	return {
		userId: 'pressure-user',
		ipKey: 'pressure-ip',
		requestId,
		method: 'message' as const,
		now,
		params: { room_id: 'general', body: { text: 'pressure probe', format: 'plain' } },
		identity: { user_id: 'pressure-user' },
	};
}

it('stops growth near the hard target, reuses pages without VACUUM, and resumes below low-water after restart', async () => {
	const stub = env.DEMO.getByName('storage-pressure-boundary-v1');
	const config = defaultStoreConfig();
	const result = await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql as unknown as CalibrationSql;
		const store = new Store(state, config, { now: () => Date.now() + 86_400_000 });
		store.initialize();
		sql.exec('CREATE TABLE pressure_calibration (id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL)').toArray();
		const payload = 's'.repeat(SNAPSHOT_BYTES);
		const transactionSync = (callback: () => void) => state.storage.transactionSync(callback);
		const nearHardTarget = config.storageHardTargetBytes - 2 * MIB;
		let rows = 0;
		while (sql.databaseSize < nearHardTarget && rows < MAX_CALIBRATION_ROWS) {
			const nextRows = Math.min(MAX_CALIBRATION_ROWS, rows + INSERT_CHUNK);
			insertCalibrationRows(sql, payload, rows + 1, nextRows, transactionSync);
			rows = nextRows;
		}
		const nearHardSize = sql.databaseSize;
		expect(rows).toBeLessThanOrEqual(MAX_CALIBRATION_ROWS);
		expect(nearHardSize).toBeGreaterThanOrEqual(config.storageHardTargetBytes - 3 * MIB);
		expect(nearHardSize).toBeGreaterThan(config.storageHighWaterBytes);

		let pressureError: unknown;
		try {
			store.commitMutation(pressureMessage(Date.now() + 86_400_000, 'pressure-near-hard'));
		} catch (error) {
			pressureError = error;
		}
		retryAfter(pressureError);

		// Delete and reinsert the same bounded rows repeatedly. The workerd
		// databaseSize contract excludes freelist pages, so reuse should keep
		// occupied bytes close to the first population without VACUUM.
		const reinsertSizes: number[] = [];
		for (let cycle = 0; cycle < 3; cycle += 1) {
			sql.exec('DELETE FROM pressure_calibration').toArray();
			insertCalibrationRows(sql, payload, 1, rows, transactionSync);
			reinsertSizes.push(sql.databaseSize);
		}
		const maxReinsertSize = Math.max(...reinsertSizes);
		const minReinsertSize = Math.min(...reinsertSizes);
		expect(maxReinsertSize - minReinsertSize).toBeLessThanOrEqual(2 * MIB);

		const rowsAtHigh = deleteUntilBelow(sql, 90 * MIB, rows);
		const highSize = sql.databaseSize;
		expect(highSize).toBeLessThanOrEqual(90 * MIB);
		expect(highSize).toBeGreaterThan(config.storageLowWaterBytes);
		return {
			nearHardSize,
			rows,
			reinsertSizes,
			rowsAtHigh,
			highSize,
		};
	});
	console.info('storage-pressure-near-hard', JSON.stringify(result));

	await evictDurableObject(stub);
	const highRestart = await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql as unknown as CalibrationSql;
		const store = new Store(state, config, { now: () => Date.now() + 86_400_000 });
		store.initialize();
		const highSize = sql.databaseSize;
		let error: unknown;
		try {
			store.commitMutation(pressureMessage(Date.now() + 86_400_000, 'pressure-high-restart'));
		} catch (candidate) {
			error = candidate;
		}
		retryAfter(error);
		const rows = Number(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pressure_calibration').one().count);
		const rowsAtLow = deleteUntilBelow(sql, config.storageLowWaterBytes - 2 * MIB, rows);
		const lowSize = sql.databaseSize;
		expect(lowSize).toBeLessThan(config.storageLowWaterBytes);
		return { highSize, rows, rowsAtLow, lowSize };
	});
	console.info('storage-pressure-high-restart', JSON.stringify(highRestart));

	await evictDurableObject(stub);
	const resumed = await runInDurableObject(stub, async (_instance, state) => {
		const store = new Store(state, config, { now: () => Date.now() + 86_400_000 });
		store.initialize();
		const commit = store.commitMutation(pressureMessage(Date.now() + 86_400_000, 'pressure-low-resume'));
		expect(commit.result.message_id).toBeTruthy();
		return { databaseSize: store.databaseSize(), status: store.accountingStatus() };
	});
	console.info('storage-pressure-low-resume', JSON.stringify(resumed));
	expect(resumed.databaseSize).toBeLessThan(config.storageLowWaterBytes);
});
