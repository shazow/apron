import { DEFAULT_LIMITS } from "./budget";

export const ERROR_CODES = Object.freeze({
	parse_error: -32700,
	invalid_request: -32600,
	unsupported: -32601,
	invalid_params: -32602,
	internal_error: -32603,
	denied: -32001,
	retry_after: -32002,
	too_large: -32003,
} as const);

export type ErrorName = keyof typeof ERROR_CODES;

export interface ProtocolError {
	name: ErrorName;
	message: string;
	data?: Record<string, unknown>;
}

export interface RequestFrame {
	method: string;
	params: Record<string, unknown>;
	id?: string;
	full: boolean;
}

export interface ParsedFrame {
	request: RequestFrame;
	bytes: number;
}

export class FrameError extends Error {
	readonly protocol: ProtocolError;
	readonly closeCode?: number;
	readonly id: string | null;
	readonly full: boolean;
	readonly notification: boolean;

	constructor(protocol: ProtocolError, options: { id?: string | null; full?: boolean; notification?: boolean; closeCode?: number } = {}) {
		super(protocol.message);
		this.name = "FrameError";
		this.protocol = protocol;
		this.id = options.id ?? null;
		this.full = options.full ?? false;
		this.notification = options.notification ?? false;
		this.closeCode = options.closeCode;
	}
}

export function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function walkJson(value: unknown, state: { nodes: number; maxDepth: number; maxNodes: number }): void {
	// Use an explicit stack: a hostile frame must never be able to exhaust the
	// JavaScript call stack before the configured depth/node gate runs.
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
	while (pending.length) {
		const current = pending.pop()!;
		state.nodes += 1;
		if (state.nodes > state.maxNodes) throw new FrameError({ name: "too_large", message: "JSON structure is too large" });
		const container = Array.isArray(current.value) || isObject(current.value);
		if (container) {
			state.maxDepth = Math.max(state.maxDepth, current.depth);
			if (current.depth > 8_192) throw new FrameError({ name: "too_large", message: "JSON structure is too deep" });
			if (Array.isArray(current.value)) {
				for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
			} else if (isObject(current.value)) {
				for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
			}
		}
	}
}

export interface ParseOptions {
	maxFrameBytes: number;
	maxJsonDepth: number;
	maxJsonNodes: number;
	maxRequestIdBytes: number;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
	maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes,
	maxJsonDepth: DEFAULT_LIMITS.maxJsonDepth,
	maxJsonNodes: DEFAULT_LIMITS.maxJsonNodes,
	maxRequestIdBytes: DEFAULT_LIMITS.maxRequestIdBytes,
};

/** Parse one application frame after applying the byte gate. */
export function parseFrame(data: string | ArrayBuffer | ArrayBufferView, options: ParseOptions = DEFAULT_PARSE_OPTIONS): ParsedFrame {
	if (typeof data !== "string") {
		throw new FrameError({ name: "invalid_request", message: "Binary application frames are not supported" }, { closeCode: 1003 });
	}
	const bytes = utf8Bytes(data);
	if (bytes > options.maxFrameBytes) {
		// Do not parse a potentially hostile oversized payload to discover an ID.
		throw new FrameError({ name: "too_large", message: "Frame exceeds the maximum size" }, { closeCode: 1009 });
	}
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		throw new FrameError({ name: "parse_error", message: "Parse error" });
	}
	const state = { nodes: 0, maxDepth: 0, maxNodes: options.maxJsonNodes };
	if (!isObject(value)) throw new FrameError({ name: "invalid_request", message: "Request must be an object" });
	const full = Object.hasOwn(value, "jsonrpc");
	let id: string | undefined;
	if (Object.hasOwn(value, "id")) {
		if (typeof value.id !== "string" || utf8Bytes(value.id) > options.maxRequestIdBytes) {
			throw new FrameError({ name: "invalid_request", message: "Request id must be a bounded string" }, { full });
		}
		id = value.id;
	}
	if (full && value.jsonrpc !== "2.0") throw new FrameError({ name: "invalid_request", message: "Invalid JSON-RPC version" }, { id: id ?? null, full });
	if (typeof value.method !== "string" || value.method.length === 0) throw new FrameError({ name: "invalid_request", message: "Method must be a non-empty string" }, { id: id ?? null, full });
	try {
		walkJson(value, state);
	} catch (error) {
		if (error instanceof FrameError) throw new FrameError(error.protocol, { id: id ?? null, full, notification: id === undefined });
		throw new FrameError({ name: "too_large", message: "JSON structure is too large" }, { id: id ?? null, full, notification: id === undefined });
	}
	let params: Record<string, unknown> = {};
	if (Object.hasOwn(value, "params")) {
		if (!isObject(value.params)) throw new FrameError({ name: "invalid_params", message: "Params must be an object" }, { id: id ?? null, full, notification: id === undefined });
		params = value.params;
	}
	// The parsed root is already bounded. Re-check the configured depth here so
	// tests and callers can use a lower policy than the guard's hard ceiling.
	const configuredDepth = state.maxDepth;
	if (configuredDepth > options.maxJsonDepth) throw new FrameError({ name: "too_large", message: "JSON nesting is too deep" }, { id: id ?? null, full, notification: id === undefined });
	return { request: { method: value.method, params, ...(id === undefined ? {} : { id }), full }, bytes };
}

export function protocolReply(id: string, result: unknown, full = false): Record<string, unknown> {
	return { ...(full ? { jsonrpc: "2.0" } : {}), id, result };
}

/** Errors not tied to a request (no known `id`) omit `id` entirely. */
export function protocolError(id: string | null | undefined, error: ProtocolError, full = false): Record<string, unknown> {
	return {
		...(full ? { jsonrpc: "2.0" } : {}),
		...(id == null ? {} : { id }),
		error: { code: ERROR_CODES[error.name], message: error.message, ...(error.data ? { data: error.data } : {}) },
	};
}

/** `data.retry_after` is whole seconds, rounded up, at least one. */
export function retryAfterSeconds(ms: number): number {
	return Math.max(1, Math.ceil(ms / 1_000));
}

export function errorFromUnknown(error: unknown): ProtocolError {
	if (error instanceof FrameError) return error.protocol;
	if (error && typeof error === "object" && "name" in error && typeof error.name === "string" && Object.hasOwn(ERROR_CODES, error.name)) {
		const typed = error as { name: ErrorName; message?: unknown; data?: unknown };
		return { name: typed.name, message: typeof typed.message === "string" ? typed.message : "Request failed", data: isObject(typed.data) ? typed.data : undefined };
	}
	return { name: "internal_error", message: "Request failed" };
}

export function jsonString(value: unknown): string {
	const result = JSON.stringify(value);
	if (result === undefined) throw new Error("cannot serialize protocol value");
	return result;
}

/** Stable recursive representation used for request deduplication. */
export function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
	}
	throw new TypeError("unsupported JSON value");
}

export async function digestRequest(method: string, params: Record<string, unknown>): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalize({ method, params }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requiredString(params: Record<string, unknown>, name: string): string {
	const value = params[name];
	if (typeof value !== "string" || value.length === 0) throw { name: "invalid_params", message: `${name} must be a non-empty string` } satisfies ProtocolError;
	return value;
}

export function optionalString(params: Record<string, unknown>, name: string): string | undefined {
	const value = params[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw { name: "invalid_params", message: `${name} must be a string` } satisfies ProtocolError;
	return value;
}

export function objectParam(params: Record<string, unknown>, name: string, required = true): Record<string, unknown> | undefined {
	const value = params[name];
	if (value === undefined && !required) return undefined;
	if (!isObject(value)) throw { name: "invalid_params", message: `${name} must be an object` } satisfies ProtocolError;
	return value;
}

export function positiveIntParam(params: Record<string, unknown>, name: string): number | undefined {
	const value = params[name];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw { name: "invalid_params", message: `${name} must be a positive integer` } satisfies ProtocolError;
	return value;
}
