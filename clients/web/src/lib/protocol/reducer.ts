import type { EventRecord, JsonObject, JsonValue, Transition, UpdateTransition } from './types';
import { isJsonObject } from './types';

export interface TimelineState {
	room: string;
	events: Record<string, EventRecord>;
	order: string[];
	seenTransitions: Record<string, true>;
	pendingUpdates: Record<string, UpdateTransition[]>;
}

export function createTimeline(room: string): TimelineState {
	return {
		room,
		events: Object.create(null) as Record<string, EventRecord>,
		order: [],
		seenTransitions: Object.create(null) as Record<string, true>,
		pendingUpdates: Object.create(null) as Record<string, UpdateTransition[]>
	};
}

/** Apply RFC 7396 JSON Merge Patch while preserving the JSON value shape. */
export function mergePatch(target: JsonValue | undefined, patch: JsonValue): JsonValue | undefined {
	if (!isJsonObject(patch)) return cloneValue(patch);

	const result: JsonObject = isJsonObject(target) ? cloneValue(target) : createJsonObject();
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
		} else {
			const next = mergePatch(result[key], value);
			if (next === undefined) delete result[key];
			else result[key] = next;
		}
	}
	return result;
}

export function applyTransition(state: TimelineState, transition: Transition): TimelineState {
	if (!isLogId(transitionId(transition))) return state;
	if (transition.kind === 'update' && !isLogId(transition.target)) return state;
	if (state.seenTransitions[transitionId(transition)]) return state;

	const next: TimelineState = {
		room: state.room,
		events: { ...state.events } as Record<string, EventRecord>,
		order: [...state.order],
		seenTransitions: { ...state.seenTransitions, [transitionId(transition)]: true } as Record<string, true>,
		pendingUpdates: copyPending(state.pendingUpdates)
	};

	if (transition.kind === 'creation') {
		const id = transition.event.event_id;
		// A raster can establish a complete target before its original creation
		// arrives. Keep that authoritative state and only replay the missing set
		// transitions queued for the target.
		if (!next.events[id]) next.events[id] = cloneEvent(transition.event);
		insertOrdered(next.order, id);
		const pending = next.pendingUpdates[id];
		if (pending) {
			for (const update of pending.sort(compareTransitions)) applyUpdate(next, update);
			delete next.pendingUpdates[id];
		}
		return next;
	}

	if (!next.events[transition.target]) {
		if (transition.replace) {
			next.events[transition.target] = cloneEvent(transition.replace, transition.target);
			insertOrdered(next.order, transition.target);
			applyNewerPending(next, transition.target, transition.event_id);
		} else {
			(next.pendingUpdates[transition.target] ??= []).push(cloneUpdate(transition));
		}
		return next;
	}

	applyUpdate(next, transition);
	return next;
}

export function applyTransitions(state: TimelineState, transitions: Transition[]): TimelineState {
	return transitions.reduce(applyTransition, state);
}

export function timelineEvents(state: TimelineState): EventRecord[] {
	return state.order.map((id) => state.events[id]).filter((event): event is EventRecord => Boolean(event));
}

function applyUpdate(state: TimelineState, update: UpdateTransition): void {
	const target = state.events[update.target];
	if (!target) return;

	if (update.replace) {
		state.events[update.target] = cloneEvent(update.replace, update.target);
		return;
	}

	if (update.set) {
		const patch = cloneValue(update.set);
		delete patch.event_id;
		const merged = mergePatch(target, patch);
		if (isJsonObject(merged)) {
			merged.event_id = update.target;
			state.events[update.target] = merged as EventRecord;
		}
	}
}

function cloneEvent(event: EventRecord, eventId = event.event_id): EventRecord {
	const copy = cloneValue(event) as EventRecord;
	copy.event_id = eventId;
	return copy;
}

function cloneUpdate(update: UpdateTransition): UpdateTransition {
	return {
		kind: 'update',
		event_id: update.event_id,
		target: update.target,
		...(update.set ? { set: cloneValue(update.set) as JsonObject } : {}),
		...(update.replace ? { replace: cloneEvent(update.replace, update.target) } : {})
	};
}

function cloneValue<T extends JsonValue>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
	const copy = createJsonObject();
	for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child);
	return copy as T;
}

function copyPending(pending: Record<string, UpdateTransition[]>): Record<string, UpdateTransition[]> {
	const copy = Object.create(null) as Record<string, UpdateTransition[]>;
	for (const [target, updates] of Object.entries(pending)) copy[target] = updates.map(cloneUpdate);
	return copy;
}

function applyNewerPending(state: TimelineState, target: string, snapshotId: string): void {
	const pending = state.pendingUpdates[target];
	delete state.pendingUpdates[target];
	if (!pending) return;
	for (const update of pending
		.filter((candidate) => compareLogIds(candidate.event_id, snapshotId) > 0)
		.sort(compareTransitions)) {
		applyUpdate(state, update);
	}
}

function insertOrdered(order: string[], id: string): void {
	if (order.includes(id)) return;
	const index = order.findIndex((existing) => compareLogIds(id, existing) < 0);
	if (index === -1) order.push(id);
	else order.splice(index, 0, id);
}

function compareTransitions(a: UpdateTransition, b: UpdateTransition): number {
	return compareLogIds(a.event_id, b.event_id);
}

export function compareLogIds(a: string, b: string): number {
	try {
		const left = BigInt(a);
		const right = BigInt(b);
		return left < right ? -1 : left > right ? 1 : 0;
	} catch {
		return a.localeCompare(b);
	}
}

function transitionId(transition: Transition): string {
	return transition.kind === 'creation' ? transition.event.event_id : transition.event_id;
}

function createJsonObject(): JsonObject {
	return Object.create(null) as JsonObject;
}

function isLogId(value: string): boolean {
	return /^[1-9]\d*$/.test(value);
}
