import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('measures indexed write costs and confirms SQLite reuses deleted pages', async () => {
	const result = await runInDurableObject(env.DEMO.getByName('native-sql-calibration'), async (_instance, state) => {
		const sql = state.storage.sql;
		sql.exec('CREATE TABLE calibration (id INTEGER PRIMARY KEY, value TEXT NOT NULL, category TEXT NOT NULL)');
		sql.exec('CREATE INDEX calibration_category ON calibration(category)');
		const insert = sql.exec('INSERT INTO calibration VALUES (?, ?, ?)', 1, 'first', 'x');
		insert.toArray();
		const insertCost = { reads: insert.rowsRead, writes: insert.rowsWritten };
		const update = sql.exec('UPDATE calibration SET value = ? WHERE id = ?', 'changed', 1);
		update.toArray();
		const updateCost = { reads: update.rowsRead, writes: update.rowsWritten };
		const payload = 'x'.repeat(8192);
		state.storage.transactionSync(() => {
			for (let i = 2; i <= 128; i++) sql.exec('INSERT INTO calibration VALUES (?, ?, ?)', i, payload, 'x');
		});
		const fullSize = sql.databaseSize;
		const removed = sql.exec('DELETE FROM calibration');
		removed.toArray();
		const deleteCost = { reads: removed.rowsRead, writes: removed.rowsWritten };
		const emptySize = sql.databaseSize;
		let freelist: number | null = null;
		try { freelist = Number(sql.exec('PRAGMA freelist_count').one().freelist_count); } catch { /* Record unsupported instrumentation explicitly. */ }
		state.storage.transactionSync(() => {
			for (let i = 1; i <= 128; i++) sql.exec('INSERT INTO calibration VALUES (?, ?, ?)', i, payload, 'x');
		});
		const reusedSize = sql.databaseSize;
		return { insertCost, updateCost, deleteCost, fullSize, emptySize, reusedSize, freelist };
	});
	console.info('native-sql-calibration', JSON.stringify(result));
	expect(result.insertCost.writes).toBeGreaterThanOrEqual(2);
	expect(result.updateCost.reads).toBeGreaterThanOrEqual(1);
	expect(result.deleteCost.writes).toBeGreaterThanOrEqual(128);
	// Reinsert is one larger payload than the first population. Allow its two
	// data pages plus a small B-tree split margin, not growth proportional to churn.
	expect(result.reusedSize).toBeLessThanOrEqual(result.fullSize + 32_768);
	expect(result.emptySize).toBeLessThanOrEqual(result.fullSize);
});
