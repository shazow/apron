import { ACCOUNT_USAGE_POLICY } from "./budget";

export interface AccountUsageSnapshot {
	day: string;
	sampledAt: number;
	workerRequests: number;
	durableObjectRequests: number;
	durableObjectDurationGbSeconds: number;
	sqlRowsRead: number;
	sqlRowsWritten: number;
	storedBytes: number;
	stop: boolean;
}

export interface AccountUsageEnvironment {
	ACCOUNT_ID?: string;
	ACCOUNT_ANALYTICS_TOKEN?: string;
}

export class AccountUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountUsageError";
	}
}

function dayFor(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function numberValue(value: unknown, field: string): number {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number) || number < 0) throw new AccountUsageError(`analytics field ${field} is invalid`);
	return number;
}

function sum(groups: unknown, field: string): number {
	if (!Array.isArray(groups)) throw new AccountUsageError(`analytics field ${field} is missing`);
	return groups.reduce((total, group) => {
		if (!group || typeof group !== "object") throw new AccountUsageError(`analytics field ${field} is invalid`);
		const value = (group as { sum?: Record<string, unknown> }).sum?.[field];
		if (value === undefined || value === null) throw new AccountUsageError(`analytics field ${field} is missing`);
		return total + numberValue(value, field);
	}, 0);
}

function max(groups: unknown, field: string): number {
	if (!Array.isArray(groups)) throw new AccountUsageError(`analytics field ${field} is missing`);
	return groups.reduce((highest, group) => {
		if (!group || typeof group !== "object") throw new AccountUsageError(`analytics field ${field} is invalid`);
		const value = (group as { max?: Record<string, unknown> }).max?.[field];
		if (value === undefined || value === null) throw new AccountUsageError(`analytics field ${field} is missing`);
		return Math.max(highest, numberValue(value, field));
	}, 0);
}

function exceedsPolicy(usage: Omit<AccountUsageSnapshot, "stop">): boolean {
	const daily = ACCOUNT_USAGE_POLICY.freeDaily;
	return usage.workerRequests >= daily.workerRequests * ACCOUNT_USAGE_POLICY.stopRatio ||
		usage.durableObjectRequests >= daily.durableObjectRequests * ACCOUNT_USAGE_POLICY.stopRatio ||
		usage.durableObjectDurationGbSeconds >= daily.durableObjectDurationGbSeconds * ACCOUNT_USAGE_POLICY.stopRatio ||
		usage.sqlRowsRead >= daily.sqlRowsRead * ACCOUNT_USAGE_POLICY.stopRatio ||
		usage.sqlRowsWritten >= daily.sqlRowsWritten * ACCOUNT_USAGE_POLICY.stopRatio ||
		usage.storedBytes >= ACCOUNT_USAGE_POLICY.freeStoredBytes * ACCOUNT_USAGE_POLICY.stopRatio;
}

export function accountUsageSnapshotFromResult(result: unknown, sampledAt: number): AccountUsageSnapshot {
	if (!result || typeof result !== "object") throw new AccountUsageError("analytics result is missing");
	const data = (result as { data?: unknown; errors?: unknown[] }).data;
	const errors = (result as { errors?: unknown[] }).errors;
	if (Array.isArray(errors) && errors.length) throw new AccountUsageError("analytics query failed");
	if (!data || typeof data !== "object") throw new AccountUsageError("analytics data is missing");
	const viewer = (data as { viewer?: { accounts?: unknown[] } }).viewer;
	const account = viewer?.accounts?.[0] as Record<string, unknown> | undefined;
	if (!account) throw new AccountUsageError("analytics account is missing");
	const usage = {
		day: dayFor(sampledAt),
		sampledAt,
		workerRequests: sum(account.workersInvocationsAdaptiveGroups, "requests"),
		durableObjectRequests: sum(account.durableObjectsInvocationsAdaptiveGroups, "requests"),
		durableObjectDurationGbSeconds: sum(account.durableObjectsPeriodicGroups, "duration"),
		sqlRowsRead: sum(account.durableObjectsPeriodicGroups, "rowsRead"),
		sqlRowsWritten: sum(account.durableObjectsPeriodicGroups, "rowsWritten"),
		storedBytes: max(account.durableObjectsStorageGroups, "storedBytes"),
	};
	return { ...usage, stop: exceedsPolicy(usage) };
}

export async function fetchAccountUsage(env: AccountUsageEnvironment, sampledAt = Date.now(), signal?: AbortSignal): Promise<AccountUsageSnapshot> {
	if (!env.ACCOUNT_ID || !env.ACCOUNT_ANALYTICS_TOKEN) throw new AccountUsageError("account analytics credentials are not configured");
	const start = new Date(Date.UTC(new Date(sampledAt).getUTCFullYear(), new Date(sampledAt).getUTCMonth(), new Date(sampledAt).getUTCDate())).toISOString();
	const end = new Date(sampledAt).toISOString();
	const query = `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(env.ACCOUNT_ID)} }) {
		workersInvocationsAdaptiveGroups(filter: { datetime_geq: ${JSON.stringify(start)}, datetime_leq: ${JSON.stringify(end)} }, limit: 1000) { sum { requests } }
		durableObjectsInvocationsAdaptiveGroups(filter: { datetime_geq: ${JSON.stringify(start)}, datetime_leq: ${JSON.stringify(end)} }, limit: 1000) { sum { requests } }
		durableObjectsPeriodicGroups(filter: { datetime_geq: ${JSON.stringify(start)}, datetime_leq: ${JSON.stringify(end)} }, limit: 1000) { sum { duration rowsRead rowsWritten } }
		durableObjectsStorageGroups(filter: { datetime_geq: ${JSON.stringify(start)}, datetime_leq: ${JSON.stringify(end)} }, limit: 1000) { max { storedBytes } }
	} } }`;
	const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.ACCOUNT_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
		signal,
	});
	if (!response.ok) throw new AccountUsageError(`analytics HTTP ${response.status}`);
	return accountUsageSnapshotFromResult(await response.json(), sampledAt);
}
