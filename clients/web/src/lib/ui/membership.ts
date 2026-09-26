import type { MembershipRecord } from '$lib/protocol/reducer';
import type { Identity } from '$lib/protocol/types';

/**
 * Join and leave lines (PROTOCOL.md §4.3.2): the pure part. The timeline
 * collects consecutive membership records, with nothing else between them,
 * into a run; a run nets out to who joined and who left, and a line names
 * them.
 */

/**
 * A record that joins more users than this at once is a baseline (a
 * compacted "every current member" record a server appends before it
 * discards history), not something that happened: it gets no line.
 */
export const BASELINE_MIN_MEMBERS = 21;

/** How many names a line spells out before it counts the rest ("and 4 others"). */
export const LISTED_NAMES = 3;

/** Whether a record is a baseline: every entry a join, and more of them than a line should hold. */
export function isBaseline(record: MembershipRecord): boolean {
	return record.entries.length >= BASELINE_MIN_MEMBERS && record.entries.every((entry) => entry.joined);
}

/** What a run of membership records amounts to, in the order each user first appears in it. */
export interface MembershipNet {
	joined: Identity[];
	left: Identity[];
}

/**
 * Collects a run's records, in log order, and nets them out per user: what
 * counts is the user's state after the run against before it, which the
 * first entry implies (a join means they were out). So a user who joins and
 * leaves again within the run is in neither list, and so is one who leaves
 * and comes back: guest churn stays quiet. Each user shows as the latest
 * recorded object in the run.
 */
export class MembershipRun {
	/** Per `user_id`: the first entry's `joined`, then the latest entry. Map order is first appearance. */
	private readonly users = new Map<string, { first: boolean; last: boolean; user: Identity }>();
	/** The first record's `log_id`: what keys the line, so it stays put as later records join the run. */
	readonly firstLogId: string;
	/** The last record's `log_id`: the time the line shows. */
	lastLogId: string;

	constructor(first: MembershipRecord) {
		this.firstLogId = first.log_id;
		this.lastLogId = first.log_id;
		this.add(first);
	}

	add(record: MembershipRecord): void {
		this.lastLogId = record.log_id;
		for (const { user, joined } of record.entries) {
			const current = this.users.get(user.user_id);
			if (current) {
				current.last = joined;
				current.user = user;
			} else {
				this.users.set(user.user_id, { first: joined, last: joined, user });
			}
		}
	}

	net(): MembershipNet {
		const joined: Identity[] = [];
		const left: Identity[] = [];
		for (const { first, last, user } of this.users.values()) {
			if (first !== last) continue;
			(last ? joined : left).push(user);
		}
		return { joined, left };
	}
}

/** Nets out records as one run (see `MembershipRun`). */
export function netMemberships(records: readonly MembershipRecord[]): MembershipNet {
	if (!records.length) return { joined: [], left: [] };
	const run = new MembershipRun(records[0]);
	for (const record of records.slice(1)) run.add(record);
	return run.net();
}

const conjunction = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * Names as a line says them: "Ada", "Ada and Bob", "Ada, Bob, and Carol",
 * and past three, the first two and a count: "Ada, Bob, and 4 others".
 */
export function listNames(names: readonly string[]): string {
	if (names.length <= LISTED_NAMES) return conjunction.format(names);
	return conjunction.format([names[0], names[1], `${names.length - 2} others`]);
}

/**
 * A run's line: "Ada joined", "Ada and Bob joined · Carol left". Empty when
 * the run netted out to nothing. `title` spells out every name, for the
 * tooltip, when the line had to count some of them.
 */
export function membershipSummary(joined: readonly string[], left: readonly string[]): { text: string; title?: string } {
	const parts: string[] = [];
	if (joined.length) parts.push(`${listNames(joined)} joined`);
	if (left.length) parts.push(`${listNames(left)} left`);
	const text = parts.join(' · ');
	if (joined.length <= LISTED_NAMES && left.length <= LISTED_NAMES) return { text };
	const full: string[] = [];
	if (joined.length) full.push(`Joined: ${joined.join(', ')}`);
	if (left.length) full.push(`Left: ${left.join(', ')}`);
	return { text, title: full.join('\n') };
}
