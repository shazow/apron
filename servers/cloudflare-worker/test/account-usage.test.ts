import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_USAGE_POLICY } from "../src/budget";
import { accountUsageSnapshotFromResult, fetchAccountUsage } from "../src/account-usage";
import { env, runInDurableObject } from "cloudflare:test";
import { Store } from "../src/store";

function result(overrides: Record<string, unknown> = {}) {
	const base = {
		workersInvocationsAdaptive: [{ sum: { requests: 1 } }],
		durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 2 } }],
		durableObjectsPeriodicGroups: [{ sum: { duration: 3, rowsRead: 4, rowsWritten: 5 } }],
		durableObjectsStorageGroups: [{ max: { storedBytes: 6 } }],
	};
	return { data: { viewer: { accounts: [{ ...base, ...overrides }] } } };
}

describe("account usage snapshots", () => {
	it("queries the supported Workers dataset and parses the response", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const { query } = JSON.parse(String(init?.body));
			expect(query).toContain("workersInvocationsAdaptive(");
			return Response.json(result());
		});
		try {
			const snapshot = await fetchAccountUsage({ ACCOUNT_ID: "test-account", ACCOUNT_ANALYTICS_TOKEN: "test-token" });
			expect(snapshot.workerRequests).toBe(1);
			expect(fetchSpy).toHaveBeenCalledOnce();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("normalizes account datasets below the stop threshold", () => {
		const snapshot = accountUsageSnapshotFromResult(result(), Date.parse("2026-09-21T12:00:00Z"));
		expect(snapshot).toMatchObject({ day: "2026-09-21", workerRequests: 1, durableObjectRequests: 2, sqlRowsRead: 4, sqlRowsWritten: 5, storedBytes: 6, stop: false });
	});

	it("stops when any shared allowance reaches the configured ratio", () => {
		const snapshot = accountUsageSnapshotFromResult(result({
			workersInvocationsAdaptive: [{ sum: { requests: ACCOUNT_USAGE_POLICY.freeDaily.workerRequests * ACCOUNT_USAGE_POLICY.stopRatio } }],
		}), Date.now());
		expect(snapshot.stop).toBe(true);
	});

	it("fails closed on API errors or missing datasets instead of treating them as zero", () => {
		expect(() => accountUsageSnapshotFromResult({ errors: [{ message: "denied" }] }, Date.now())).toThrow();
		expect(() => accountUsageSnapshotFromResult({ data: { viewer: { accounts: [{}] } } }, Date.now())).toThrow();
	});

	it("rejects negative or non-numeric usage values", () => {
		expect(() => accountUsageSnapshotFromResult(result({
			workersInvocationsAdaptive: [{ sum: { requests: -1 } }],
		}), Date.now())).toThrow();
		expect(() => accountUsageSnapshotFromResult(result({
			durableObjectsPeriodicGroups: [{ sum: { duration: "unknown", rowsRead: 1, rowsWritten: 1 } }],
		}), Date.now())).toThrow();
	});

	it("persists the snapshot in existing Durable Object metadata", async () => {
		const snapshot = accountUsageSnapshotFromResult(result(), Date.parse("2026-09-21T12:00:00Z"));
		await runInDurableObject(env.DEMO.getByName("account-usage-snapshot"), (_instance, state) => {
			const store = new Store(state, {});
			store.initialize();
			store.persistAccountUsageSnapshot(snapshot);
			const restarted = new Store(state, {});
			restarted.initialize();
			expect(restarted.accountUsageSnapshot()).toEqual(snapshot);
		});
	});
});
