import { isJsonObject, type JsonValue, type MessageRecord, type Transition } from './types';

export interface TimelineState {
	room: string;
	events: Record<string, MessageRecord>;
	order: string[];
	latestLogs: Record<string, string>;
}

export function createTimeline(room: string): TimelineState {
	return { room, events: Object.create(null), order: [], latestLogs: Object.create(null) };
}

export function compareLogIds(a: string, b: string): number {
	const left = BigInt(a), right = BigInt(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

// Preserve unknown JSON fields, including literal null and prototype-like keys.
function cloneValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (isJsonObject(value)) {
		const copy = Object.create(null);
		for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
		return copy;
	}
	return value;
}

/** Each snapshot stands alone. Overlapping history and live delivery can arrive in any order. */
export class TimelineReplay {
	private readonly state: TimelineState;
	constructor(state: TimelineState) {
		this.state = {
			room: state.room, events: Object.assign(Object.create(null), state.events),
			order: [...state.order], latestLogs: Object.assign(Object.create(null), state.latestLogs)
		};
	}
	apply(transitions: Transition[]): void {
		for (const { log_id, message } of transitions) {
			const id = message.message_id;
			const previous = this.state.latestLogs[id];
			if (previous && compareLogIds(log_id, previous) <= 0) continue;
			if (!previous) this.state.order.push(id);
			this.state.events[id] = cloneValue(message) as MessageRecord;
			this.state.latestLogs[id] = log_id;
		}
	}

	/** Remove snapshots whose latest authoritative transition is below a retention floor. */
	pruneBefore(floor: string): void {
		for (const id of [...this.state.order]) {
			const latest = this.state.latestLogs[id];
			if (!latest || compareLogIds(latest, floor) >= 0) continue;
			delete this.state.latestLogs[id];
			delete this.state.events[id];
		}
		this.state.order = this.state.order.filter((id) => Object.hasOwn(this.state.events, id));
	}
	finish(): TimelineState {
		this.state.order.sort(compareLogIds);
		return this.state;
	}
}

export function applyTransitions(state: TimelineState, transitions: Transition[]): TimelineState {
	const replay = new TimelineReplay(state);
	replay.apply(transitions);
	return replay.finish();
}

export function applyTransition(state: TimelineState, transition: Transition): TimelineState {
	return applyTransitions(state, [transition]);
}

export function timelineEvents(state: TimelineState): MessageRecord[] {
	return state.order.map((id) => state.events[id]);
}

/**
 * Apply a retention floor without changing snapshots whose latest transition is
 * still retained. A message may have an old creation ID and remain visible
 * after a recent edit, so pruning is keyed by log ID rather than message ID.
 */
export function pruneTimelineBefore(state: TimelineState, floor: string): TimelineState {
	if (!isPositiveLogId(floor)) return state;
	const replay = new TimelineReplay(state);
	replay.pruneBefore(floor);
	return replay.finish();
}

function isPositiveLogId(value: string): boolean {
	return /^[1-9]\d*$/.test(value);
}
