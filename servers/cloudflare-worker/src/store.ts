/*
 * Durable storage for the public Apron demo.
 *
 * The worker deliberately keeps all authoritative state behind this module.  A
 * Durable Object is single threaded, but requests can still be interleaved at
 * every await in the websocket handler.  Store methods are synchronous with
 * respect to SQLite; callers can therefore make the reply/broadcast gate wait
 * for a complete mutation before exposing its result.
 */

import {
  BOOTSTRAP_ROW_RESERVATION,
  DEFAULT_LIMITS,
  MAINTENANCE_CONTROL_RESERVE,
  MAX_EMOJI_BYTES,
  MAX_THREAD_LIMIT,
} from "./budget";
import type { AccountUsageSnapshot } from "./account-usage";
import type {
  AdmissionSnapshot,
  AuthTier,
  CleanupResult as DomainCleanupResult,
  DedupRecord,
  Identity as DomainIdentity,
  StoredCredential,
  StoredIdentity,
} from "./domain.js";
// @ts-expect-error Workers' nodejs_compat runtime supplies this module; the
// worker type package intentionally omits Node's full module declarations.
import { createHash } from "node:crypto";

/** The seeded, permanent top-level room. */
export const ROOM_ID = "general";
export const ROOM_TITLE = "General";
/**
 * Schema 4 stores the protocol v6 server-wide log (room records, flat message
 * snapshots, reaction sets, and registered users' memberships) and a
 * `memberships` table of registered users' joined rooms, indexed both ways.
 * Stored data from any other schema version is not migrated: the object is
 * wiped and started fresh (see resetStorage()). Additive rows need no new
 * version: the `_meta` guest-number mark, absent in older schema 4 objects,
 * reads as zero.
 */
export const SCHEMA_VERSION = 4;
/** Rooms a new identity has joined: the permanent top-level room (§3.4). */
export const DEFAULT_JOINED_ROOMS: readonly string[] = [ROOM_ID];
/** Title the demo supplies for a thread room created or saved without one. */
export const DEFAULT_THREAD_TITLE = "Thread";
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
export const RETENTION_MS = DEFAULT_LIMITS.retentionSeconds * 1000;
export const DEDUP_TTL_MS = DEFAULT_LIMITS.dedupTtlSeconds * 1000;
export const POST_WINDOW_MS = 60 * 1000;

// Keep a small durable control reserve inside the maintenance allocation.
// When a batch cannot be admitted, these rows are still enough to move the
// persisted cleanup deadline to the next UTC budget reset.  Without this gap,
// an exhausted maintenance budget would leave a due timestamp behind and an
// alarm would wake the object continuously.
const MAINTENANCE_CONTROL_READS = MAINTENANCE_CONTROL_RESERVE;
const MAINTENANCE_CONTROL_WRITES = MAINTENANCE_CONTROL_RESERVE;

// A budget row is retained for the active UTC day only.  Rollover pruning is
// deliberately a tiny bounded operation: old rows are bookkeeping, and a
// busy object may have accumulated more than one day while it was asleep.
// Keep enough reservation headroom for the bounded DELETE and its index work.
const BUDGET_PRUNE_RESERVATION_READS = 8;
const BUDGET_PRUNE_RESERVATION_WRITES = 8;
const BUDGET_PRUNE_BATCH = 4;

export type Tier = "anonymous" | "registered";

export type ErrorCode =
  | "parse_error"
  | "invalid_request"
  | "unsupported"
  | "invalid_params"
  | "internal_error"
  | "denied"
  | "retry_after"
  | "too_large";

export class StoreError extends Error {
  readonly code: ErrorCode;
  /** Delay the socket layer reports as `data.retry_after`, in whole seconds. */
  readonly retryAfterMs?: number;
  /** Extra error `data` keys, such as `reason`. */
  readonly data?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryAfterMs?: number; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.data = options.data;
  }
}

export interface SqlCursorLike<T = Record<string, unknown>> {
  toArray?: () => T[];
  one?: () => T;
  raw?: () => unknown[];
  rowsRead?: number;
  rowsWritten?: number;
  [Symbol.iterator]?: () => Iterator<T>;
}

export interface SqlStorageLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

export interface DurableStorageLike {
  sql: SqlStorageLike;
  transactionSync?: <T>(closure: () => T) => T;
  setAlarm?: (time: number | Date) => Promise<void>;
  deleteAll?: () => Promise<void>;
  getAlarm?: () => Promise<number | null>;
}

export interface DurableStateLike {
  storage: DurableStorageLike;
}

export type DurableSqlStorageLike = DurableStorageLike;

export interface StoreClock {
  now(): number;
}

export interface StoreConfig {
  retentionMs: number;
  dedupTtlMs: number;
  cleanupIntervalMs: number;
  cleanupBatch: number;
  maxSnapshotBytes: number;
  maxTextBytes: number;
  maxNameBytes: number;
  maxNameCodePoints: number;
  maxEmbeds: number;
  /** Thread rooms (rooms with a parent) that may exist at once. */
  maxThreads: number;
  /** Serialized client fields of one room record. */
  maxThreadMetadataBytes: number;
  reactionUsersPerMessage: number;
  reactionEmojisPerUser: number;
  maxHistoryLimit: number;
  historyDefaultLimit: number;
  maxHistoryResponseBytes: number;
  historyRequestsPerUserMinute: number;
  historyRequestsPerIpMinute: number;
  anonymousPostsPerMinute: number;
  anonymousPostsPerDay: number;
  registeredPostsPerMinute: number;
  registeredPostsPerDay: number;
  ipPostsPerMinute: number;
  ipPostsPerDay: number;
  globalPostsPerMinute: number;
  globalPostsPerDay: number;
  registrationsPerIpDay: number;
  registrationsPerDay: number;
  registeredIdentityCount: number;
  authAttemptsPerIpMinute: number;
  framesPerConnectionMinute: number;
  framesPerIpMinute: number;
  processedFramesPerDay: number;
  openConnections: number;
  anonymousConnectionsPerIp: number;
  registeredConnectionsPerUser: number;
  connectionsPerIp: number;
  connectionAdmissionsPerIpMinute: number;
  connectionAdmissionsPerDay: number;
  principalLimitCap: number;
  sqlReadsPerDay: number;
  sqlWritesPerDay: number;
  foregroundReadsPerDay: number;
  foregroundWritesPerDay: number;
  maintenanceReadsPerDay: number;
  maintenanceWritesPerDay: number;
  /** Occupied SQLite bytes at which foreground growth is suspended. */
  storageHighWaterBytes: number;
  /** Hard target including control data and cleanup headroom. */
  storageHardTargetBytes: number;
  /** Effective occupied bytes below which growth may resume. */
  storageLowWaterBytes: number;
  /** Optional operator switch. */
  admissionEnabled: boolean;
  /** Conservative row-cost estimate for one foreground mutation. */
  mutationCost: CostEstimate;
  /** Conservative row-cost estimate for one history read. */
  historyCost: CostEstimate;
  /** Conservative row-cost estimate for one auth attempt. */
  authCost: CostEstimate;
  /** Conservative row-cost estimate for one maintenance batch. */
  cleanupCost: CostEstimate;
}

export interface CostEstimate {
  reads?: number;
  writes?: number;
  frames?: number;
  admissions?: number;
  posts?: number;
  registrations?: number;
}

const DEFAULT_CONFIG: StoreConfig = {
  retentionMs: RETENTION_MS,
  dedupTtlMs: DEDUP_TTL_MS,
  cleanupIntervalMs: DEFAULT_LIMITS.cleanupSeconds * 1000,
  cleanupBatch: DEFAULT_LIMITS.cleanupBatch,
  maxSnapshotBytes: DEFAULT_LIMITS.maxSnapshotBytes,
  maxTextBytes: DEFAULT_LIMITS.maxTextBytes,
  maxNameBytes: DEFAULT_LIMITS.maxNameBytes,
  maxNameCodePoints: DEFAULT_LIMITS.maxNameCodePoints,
  maxEmbeds: DEFAULT_LIMITS.maxEmbeds,
  maxThreads: DEFAULT_LIMITS.threadLimit,
  maxThreadMetadataBytes: DEFAULT_LIMITS.threadMetadataBytes,
  reactionUsersPerMessage: DEFAULT_LIMITS.reactionUsersPerMessage,
  reactionEmojisPerUser: DEFAULT_LIMITS.reactionEmojisPerUser,
  maxHistoryLimit: DEFAULT_LIMITS.historyMaxLimit,
  historyDefaultLimit: DEFAULT_LIMITS.historyDefaultLimit,
  maxHistoryResponseBytes: DEFAULT_LIMITS.historyMaxResponseBytes,
  historyRequestsPerUserMinute: DEFAULT_LIMITS.historyRequestsPerUserMinute,
  historyRequestsPerIpMinute: DEFAULT_LIMITS.historyRequestsPerIpMinute,
  anonymousPostsPerMinute: DEFAULT_LIMITS.anonymousPostsPerMinute,
  anonymousPostsPerDay: DEFAULT_LIMITS.anonymousPostsPerDay,
  registeredPostsPerMinute: DEFAULT_LIMITS.registeredPostsPerMinute,
  registeredPostsPerDay: DEFAULT_LIMITS.registeredPostsPerDay,
  ipPostsPerMinute: DEFAULT_LIMITS.ipPostsPerMinute,
  ipPostsPerDay: DEFAULT_LIMITS.ipPostsPerDay,
  globalPostsPerMinute: DEFAULT_LIMITS.globalPostsPerMinute,
  globalPostsPerDay: DEFAULT_LIMITS.globalPostsPerDay,
  registrationsPerIpDay: DEFAULT_LIMITS.registrationsPerIpDay,
  registrationsPerDay: DEFAULT_LIMITS.registrationsPerDay,
  registeredIdentityCount: DEFAULT_LIMITS.registeredIdentityCount,
  authAttemptsPerIpMinute: DEFAULT_LIMITS.authAttemptsPerIpMinute,
  framesPerConnectionMinute: DEFAULT_LIMITS.framesPerConnectionMinute,
  framesPerIpMinute: DEFAULT_LIMITS.framesPerIpMinute,
  processedFramesPerDay: DEFAULT_LIMITS.processedFramesPerDay,
  openConnections: DEFAULT_LIMITS.openConnections,
  anonymousConnectionsPerIp: DEFAULT_LIMITS.anonymousConnectionsPerIp,
  registeredConnectionsPerUser: DEFAULT_LIMITS.registeredConnectionsPerUser,
  connectionsPerIp: DEFAULT_LIMITS.connectionsPerIp,
  connectionAdmissionsPerIpMinute: DEFAULT_LIMITS.connectionAdmissionsPerIpMinute,
  connectionAdmissionsPerDay: DEFAULT_LIMITS.connectionAdmissionsPerDay,
  principalLimitCap: DEFAULT_LIMITS.limiterRecordCap,
  sqlReadsPerDay: DEFAULT_LIMITS.sqlReadsPerDay,
  sqlWritesPerDay: DEFAULT_LIMITS.sqlWritesPerDay,
  foregroundReadsPerDay: DEFAULT_LIMITS.foregroundReadsPerDay,
  foregroundWritesPerDay: DEFAULT_LIMITS.foregroundWritesPerDay,
  maintenanceReadsPerDay: DEFAULT_LIMITS.maintenanceReadsPerDay,
  maintenanceWritesPerDay: DEFAULT_LIMITS.maintenanceWritesPerDay,
  storageHighWaterBytes: DEFAULT_LIMITS.databaseHighWaterBytes,
  storageHardTargetBytes: DEFAULT_LIMITS.databaseHardTargetBytes,
  storageLowWaterBytes: DEFAULT_LIMITS.databaseResumeLowWaterBytes,
  admissionEnabled: true,
  // These bounds include the reservation row and worst-case indexed control
  // updates for one accepted operation; calibrated workloads may lower them
  // only after observing cursor counts.
  mutationCost: { reads: 64, writes: 64, posts: 1 },
  historyCost: { reads: 64 },
  authCost: { reads: 24, writes: 8, frames: 1 },
  cleanupCost: { reads: 1024, writes: 1024 },
};

export function defaultStoreConfig(overrides: Partial<StoreConfig> = {}): StoreConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (merged.retentionMs <= 0 || merged.dedupTtlMs <= 0) {
    throw new Error("retention and dedup TTL must be positive");
  }
  if (merged.maxSnapshotBytes <= 0 || merged.maxTextBytes <= 0) {
    throw new Error("snapshot and text limits must be positive");
  }
  if (merged.historyDefaultLimit <= 0 || merged.maxHistoryLimit < merged.historyDefaultLimit) {
    throw new Error("history limits are inconsistent");
  }
  if (merged.storageLowWaterBytes >= merged.storageHighWaterBytes ||
      merged.storageHighWaterBytes >= merged.storageHardTargetBytes) {
    throw new Error("storage watermarks are inconsistent");
  }
  if (merged.foregroundReadsPerDay > merged.sqlReadsPerDay ||
      merged.maintenanceReadsPerDay > merged.sqlReadsPerDay ||
      merged.foregroundWritesPerDay > merged.sqlWritesPerDay ||
      merged.maintenanceWritesPerDay > merged.sqlWritesPerDay) {
    throw new Error("foreground/maintenance budgets exceed daily ceilings");
  }
  if (merged.maintenanceReadsPerDay <= MAINTENANCE_CONTROL_READS ||
      merged.maintenanceWritesPerDay <= MAINTENANCE_CONTROL_WRITES) {
    throw new Error("maintenance budgets must leave control reserve");
  }
  if (merged.cleanupBatch <= 0 || merged.cleanupBatch > 100) {
    throw new Error("cleanup batch must be between 1 and 100");
  }
  return merged;
}

export interface Identity {
  user_id: string;
  name?: string;
  tier?: Tier;
}

/** A flat, self-describing message snapshot (protocol v6 section 3.5). */
export interface MessageSnapshot {
  message_id: string;
  log_id: string;
  room_id: string;
  from: Identity;
  body?: Record<string, unknown>;
  reply_to?: { message_id: string };
  deleted?: boolean;
  ext?: Record<string, unknown>;
  /** The previous snapshot's log_id (section 2); absent on creation. */
  prev_log_id?: string;
  /** The previous snapshot's room, when a move changed it (section 2). */
  prev_room_id?: string;
}

/** A room record plus this server's delivery fields (protocol v6 section 3.4). */
export interface RoomRecord {
  room_id: string;
  log_id: string;
  parent_room_id?: string;
  title?: string;
  intro_message?: Record<string, unknown>;
  ext?: Record<string, unknown>;
  latest_log_id: string;
  history_log_id: string | null;
}

/** One logged reaction change (protocol v6 §4.5). */
export interface ReactionsRecord {
  log_id: string;
  message_id: string;
  room_id: string;
  reactions: Array<{ from: Identity; emojis: string[] }>;
}

/** One logged membership change of a registered user (protocol v6 §4.3.2). */
export interface MembershipRecord {
  log_id: string;
  room_id: string;
  members: Array<{ user: Identity; joined: boolean }>;
}

export type RecordKind = "room" | "message" | "reactions" | "membership";

/**
 * A committed record, in log order, ready to deliver as a notification to the
 * members of `rooms`: its room, and for a move both rooms (§3.4, §4.1).
 */
export interface Broadcast {
  method: "message" | "reactions" | "membership";
  params: Record<string, unknown>;
  rooms: string[];
}

export type MutationMethod = "message" | "room_set" | "reactions" | "me";

export interface StoreMutationInput {
  userId: string;
  tier?: Tier;
  ipKey: string;
  requestId?: string;
  method?: MutationMethod | string;
  now?: number;
  /** The complete request parameters; saves replace every client field. */
  params: Record<string, unknown>;
  identity: Identity;
  digest?: string;
}

export interface StoreMutationResult {
  result: Record<string, unknown>;
  /** Records committed by this operation, in ascending log order. */
  broadcasts: Broadcast[];
  /** The saved message snapshot, for message operations. */
  message?: MessageSnapshot;
  /** The saved room record, for `room_set`. */
  room?: RoomRecord;
  /** Whether `room_set` created the room, which joins its creator (§4.3.4). */
  created?: boolean;
  /** The creator's logged membership, for a registered creator (§4.3.4). */
  membership?: Broadcast;
  /** An accepted retry: the original result, with no new records. */
  deduplicated?: boolean;
}

export interface StoreHistoryQuery {
  /** Omitted, the default room (§4.1). */
  roomId?: string;
  after?: string | bigint;
  before?: string | bigint;
  limit?: number;
  now?: number;
  /** Request identity for history quota accounting. */
  userId?: string;
  ipKey?: string;
  maxBytes?: number;
}

/** A history page (§4.1): each array is omitted when empty, and the bounds with it. */
export interface StoreHistoryResult {
  rooms?: RoomRecord[];
  messages?: MessageSnapshot[];
  reactions?: ReactionsRecord[];
  membership?: MembershipRecord[];
  first_log_id?: string;
  last_log_id?: string;
  more: boolean;
  latest_log_id: string;
  history_log_id: string | null;
}

export interface StoreCleanupResult {
  /** The internal server-wide retention floor F after this run. */
  history_floor: string;
  /** F before this run; rooms' history_log_id changed when these differ. */
  previous_floor: string;
  /** The server-wide log head. */
  latest_id: string;
  deleted_records: number;
  deleted_messages: number;
  deleted_reactions: number;
  /** Membership rows of removed thread rooms purged by this run. */
  deleted_memberships: number;
  deleted_requests: number;
  deleted_limiters: number;
  /** Thread rooms whose entire log expired; announce them as removed. */
  removed_rooms: string[];
  next_due_ms: number;
  did_work: boolean;
}

/** What crediting back a reservation's unused part costs: one indexed row update. */
const REFUND_READS = 1;
const REFUND_WRITES = 1;

export interface BudgetCost {
  reads: number;
  writes: number;
  frames: number;
  admissions: number;
  posts: number;
  registrations: number;
  /** Set on a reservation charged to a day's budget row, so its unused part can be refunded. */
  day?: string;
  maintenance?: boolean;
}

export interface BudgetSnapshot extends BudgetCost {
  day: string;
  foreground_reads: number;
  foreground_writes: number;
  maintenance_reads: number;
  maintenance_writes: number;
}

interface RawBudgetRow {
  day: string;
  reads_reserved: number;
  writes_reserved: number;
  frames_reserved: number;
  admissions_reserved: number;
  posts_reserved: number;
  registrations_reserved: number;
  foreground_reads: number;
  foreground_writes: number;
  maintenance_reads: number;
  maintenance_writes: number;
}

interface RawLogState {
  last_log_id: number;
  history_floor: number;
  last_commit_ms: number;
}

interface RawRoomRow {
  room_id: string;
  parent_room_id: string | null;
  created_log_id: number;
  record_log_id: number;
  latest_log_id: number;
  intro_message_id: string | null;
  fields_json: string;
  created_ms: number;
  updated_ms: number;
}

interface RawRoomListRow extends RawRoomRow {
  intro_snapshot_json: string | null;
  intro_log_id: number | null;
}

interface RawRecordRow {
  room_id: string;
  log_id: number;
  kind: string;
  record_json: string;
}

interface RawMessageRow {
  message_id: string;
  room_id: string;
  latest_log_id: number;
  snapshot_json: string;
  author_id: string;
}

interface RawReactionRow {
  message_id: string;
  user_id: string;
  log_id: number;
  from_json: string;
  emojis_json: string;
}

/** Allocation and room bookkeeping for one committed operation. */
interface CommitContext {
  state: RawLogState;
  commitMs: number;
  /** Greatest log_id appended to each existing room during this commit. */
  touched: Map<string, number>;
}

const ROOM_COLUMNS = "room_id, parent_room_id, created_log_id, record_log_id, latest_log_id, intro_message_id, fields_json, created_ms, updated_ms";

interface RawDedupRow {
  user_id: string;
  request_id: string;
  digest: string;
  result_json: string;
  transition_json: string | null;
  expires_ms: number;
}

interface RawCredentialRow {
  credential_id: string;
  user_id: string;
  public_key_json: string;
  sign_count: number;
  transports_json: string | null;
  created_ms: number;
  updated_ms: number;
}

interface RawIdentityRow {
  user_id: string;
  user_handle: string;
  name: string;
  tier: string;
  created_ms: number;
  updated_ms: number;
}

interface RawLimitRow {
  scope: string;
  principal_key: string;
  post_events_json: string;
  auth_events_json: string;
  history_events_json: string;
  admission_events_json: string;
  day: string;
  posts_day: number;
  registrations_day: number;
  updated_ms: number;
}

interface RawMaintenanceRow {
  id: number;
  next_cleanup_ms: number;
  cleanup_cutoff_ms: number | null;
  cleanup_cursor: number | null;
  schema_version: number;
}

const META_EFFECTIVE_NOW = "effective_now_ms";
/**
 * Removed thread rooms whose membership rows cleanup has yet to purge, as a
 * JSON array. A room leaves the `rooms` table at once and its members are
 * purged in bounded batches; membership reads join `rooms`, so they never
 * see a purged room's rows.
 */
const META_PURGE_ROOMS = "purge_rooms";
/** Most removed rooms awaiting purge; cleanup removes no further room past it. */
const MAX_PURGE_ROOMS = MAX_THREAD_LIMIT;
const META_ACCOUNTING_UNSAFE = "accounting_unsafe";
const META_ACCOUNT_USAGE = "account_usage_snapshot";
/**
 * The highest guest number ever reserved (see reserveGuestNumbers). Absent
 * means none: the row is additive, so schema 4 objects need no reset for it.
 */
const META_GUEST_NUMBER_MARK = "guest_number_mark";
/** Rows one guest-number block reservation may read and write, before control overhead. */
const GUEST_NUMBER_BLOCK_COST = { reads: 8, writes: 8 } as const;

function numericId(value: string, field = "id"): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new StoreError("invalid_params", `${field} must be a decimal string`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || String(number) !== value.replace(/^0+(?=\d)/, "")) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return number;
}

function numericBigInt(value: bigint, field = "id"): string {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(MAX_SAFE_ID)) {
    throw new StoreError("invalid_params", `${field} is outside the supported range`);
  }
  return value.toString();
}

function idString(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_ID) {
    throw new StoreError("internal_error", "identifier range exhausted");
  }
  return String(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseJson<T>(value: string, fallback?: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new StoreError("internal_error", "corrupt persisted JSON");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dayFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function positiveLimit(value: number | undefined, defaultValue: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value <= 0) {
    throw new StoreError("invalid_params", "limit must be a positive integer");
  }
  return Math.min(value, max);
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("invalid_params", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Canonical JSON used by mutation deduplication.  Object keys are sorted at
 * every level, arrays retain order, and JSON types remain distinct.  The
 * envelope's `jsonrpc` field is intentionally outside this function: callers
 * pass only method and params.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreError("invalid_params", "non-finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
  }
  throw new StoreError("invalid_params", "unsupported value in request");
}


export function digestOperation(method: string, params: unknown): string {
  return createHash("sha256").update(canonicalize({ method, params }), "utf8").digest("hex");
}

function cursorRows<T>(cursor: SqlCursorLike<T>): T[] {
  if (typeof cursor.toArray === "function") return cursor.toArray();
  if (typeof cursor[Symbol.iterator] === "function") return Array.from(cursor as Iterable<T>);
  if (typeof cursor.one === "function") {
    try { return [cursor.one()]; } catch { return []; }
  }
  return [];
}

function integerColumn(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/**
 * A room's inclusive history lower bound. It is the server-wide retention
 * floor F, raised to the room's creation record. It never decreases: F is
 * monotonic, and a room reports null (effective bound latest + 1) only while
 * F > latest, so any later record in the room is at least F.
 */
function roomHistoryFloor(room: Pick<RawRoomRow, "created_log_id">, floor: number): number {
  return Math.max(floor, room.created_log_id);
}

function roomHistoryLogId(room: Pick<RawRoomRow, "created_log_id" | "latest_log_id">, floor: number): string | null {
  const lower = roomHistoryFloor(room, floor);
  return lower <= room.latest_log_id ? idString(lower) : null;
}

/** A stored list of room IDs, dropping anything malformed. */
function roomIdList(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value || "[]", []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 64))];
}

/** A membership's recorded user (§3.3): `user_id` and a non-empty `name`. */
function recordedUser(userId: string, name: string | null | undefined): Identity {
  return { user_id: userId, ...(name ? { name } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") throw new StoreError("invalid_params", `${field} must be a string`);
  if (utf8Bytes(value) > maxBytes) throw new StoreError("too_large", `${field} is too large`);
  return value;
}

/**
 * Schema 4: the server-wide log with membership records, and each registered
 * identity's joined rooms as `memberships` rows, by room (the primary key, for
 * member listings) and by user (for a user's rooms). Guests' memberships live
 * in their connection only, like the guest identity itself, and are not logged.
 */
const SCHEMA_V4_DDL = `
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS log_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_log_id INTEGER NOT NULL,
    history_floor INTEGER NOT NULL,
    last_commit_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    parent_room_id TEXT,
    created_log_id INTEGER NOT NULL,
    record_log_id INTEGER NOT NULL,
    latest_log_id INTEGER NOT NULL,
    intro_message_id TEXT,
    fields_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    room_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    commit_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (room_id, log_id)
  );
  CREATE INDEX IF NOT EXISTS records_log_idx ON records (log_id);
  CREATE INDEX IF NOT EXISTS records_retention_idx ON records (commit_ms, log_id);
  CREATE TABLE IF NOT EXISTS message_state (
    message_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    latest_log_id INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    author_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS message_state_latest_idx ON message_state (latest_log_id);
  CREATE TABLE IF NOT EXISTS reaction_state (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    log_id INTEGER NOT NULL,
    from_json TEXT NOT NULL,
    emojis_json TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS reaction_state_log_idx ON reaction_state (log_id);
  CREATE TABLE IF NOT EXISTS identities (
    user_id TEXT PRIMARY KEY,
    user_handle TEXT NOT NULL,
    name TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memberships (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
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

export class Store {
  readonly config: StoreConfig;
  readonly sql: SqlStorageLike;
  readonly clock: StoreClock;
  private readonly durableStorage?: DurableStateLike["storage"];
  private readonly transactionSync?: <T>(closure: () => T) => T;
  private initialized = false;
  private inTransaction = false;
  private observed = {
    reads: 0,
    writes: 0,
    operations: 0,
    reservedReads: 0,
    reservedWrites: 0,
  };
  private lastEffectiveMs = 0;
  private budgetCacheDay: string | null = null;
  private budgetCache: RawBudgetRow | null = null;
  private budgetStopLoggedDay: string | null = null;
  private budgetHandoverPending = false;

  /** UTC day for which this object has already attempted bounded row pruning. */
  private budgetPruneDay: string | null = null;
  private accountingUnsafe = false;
  private accountingUnsafePersisted = false;
  private accountingUnsafePending = false;
  private deferredCleanupUntil = 0;
  private scheduledAlarmAt?: number;

  constructor(
    storageOrState: unknown,
    config: Partial<StoreConfig> = {},
    clock: StoreClock | (() => number) = { now: () => Date.now() },
  ) {
    const candidate = storageOrState as SqlStorageLike | DurableStateLike | DurableSqlStorageLike;
    if (candidate && typeof candidate === "object" && "exec" in candidate) {
      this.durableStorage = undefined;
      this.sql = candidate as SqlStorageLike;
    } else if (candidate && typeof candidate === "object" && "storage" in candidate) {
      const state = candidate as DurableStateLike;
      this.durableStorage = state.storage;
      this.sql = state.storage.sql;
    } else {
      const storage = candidate as DurableSqlStorageLike;
      this.durableStorage = storage;
      this.sql = storage.sql;
    }
    this.transactionSync = this.durableStorage?.transactionSync?.bind(this.durableStorage);
    this.config = defaultStoreConfig(config);
    this.clock = typeof clock === "function" ? { now: clock } : clock;
  }

  /** Initializes schema once. Calling this on every hibernation wake is safe. */
  initialize(): void {
    if (this.initialized) return;
    // DDL is deliberately one initialization batch. The schema version marker
    // is checked before DDL so a wake/restart does not rewrite schema state.
    const version = this.readSchemaVersion();
    if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`storage schema ${version} requires resetStorage()`);
    if (version === SCHEMA_VERSION) {
      const persistedEffective = Number(this.metaValue(META_EFFECTIVE_NOW));
      if (Number.isSafeInteger(persistedEffective) && persistedEffective >= 0) this.lastEffectiveMs = persistedEffective;
      const unsafeMarker = this.metaValue(META_ACCOUNTING_UNSAFE).trim().toLowerCase();
      if (unsafeMarker === "1" || unsafeMarker === "true") {
        this.accountingUnsafe = true;
        this.accountingUnsafePersisted = true;
      }
      const startupDay = dayFor(Math.max(this.lastEffectiveMs, this.clock.now()));
      const startupRows = this.rawRows<RawBudgetRow>(
        `SELECT day, reads_reserved, writes_reserved, frames_reserved,
            admissions_reserved, posts_reserved, registrations_reserved,
            foreground_reads, foreground_writes, maintenance_reads, maintenance_writes
         FROM resource_budgets WHERE day = ? LIMIT 1`,
        startupDay,
      );
      if (startupRows.length) {
        this.budgetCacheDay = startupDay;
        this.budgetCache = { ...startupRows[0] };
      }
      // Schema/effective-clock handover reads are charged to the first
      // durable reservation after a wake. No schema rows are rewritten here.
      this.budgetHandoverPending = true;
      // The current row was loaded from durable state on this wake. Defer
      // pruning until a later UTC rollover so constructor reads remain the
      // only recurring work performed during a hibernation wake.
      this.budgetPruneDay = startupDay;
      this.initialized = true;
      return;
    }
    const now = this.transaction(() => {
      this.rawScript(SCHEMA_V4_DDL);
      const now = this.effectiveNow(this.clock.now());
      this.bootstrapSchema(now);
      // Charge the one-time schema/bootstrap work to the maintenance reserve.
      // This marker is written only during a schema-version transition, never
      // on hibernation wakes or ordinary constructor calls.
      const startupCost = { reads: BOOTSTRAP_ROW_RESERVATION, writes: BOOTSTRAP_ROW_RESERVATION };
      const startupDay = dayFor(now);
      this.rawExec(
        `INSERT OR IGNORE INTO resource_budgets
         (day, reads_reserved, writes_reserved, frames_reserved, admissions_reserved,
          posts_reserved, registrations_reserved, foreground_reads, foreground_writes,
          maintenance_reads, maintenance_writes)
         VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
        startupDay,
      );
      this.rawExec(
        "UPDATE resource_budgets SET reads_reserved = reads_reserved + ?, writes_reserved = writes_reserved + ?, maintenance_reads = maintenance_reads + ?, maintenance_writes = maintenance_writes + ? WHERE day = ?",
        startupCost.reads,
        startupCost.writes,
        startupCost.reads,
        startupCost.writes,
        startupDay,
      );
      this.observed.reservedReads += startupCost.reads;
      this.observed.reservedWrites += startupCost.writes;
      return now;
    });
    this.budgetCacheDay = null;
    this.budgetCache = null;
    this.budgetHandoverPending = true;
    this.budgetPruneDay = dayFor(Math.max(this.lastEffectiveMs, now, this.clock.now()));
    this.initialized = true;
  }

  /** Seed control rows and the permanent `general` room in a new object. */
  private bootstrapSchema(now: number): void {
    this.rawExec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?), ('effective_now_ms', ?), ('identity_count', '0'), ('thread_count', '0'), ('principal_limit_count', '0'), ('budget_stop_day', ''), ('accounting_unsafe', '0')",
      String(SCHEMA_VERSION),
      String(now),
    );
    this.rawExec(
      "INSERT OR REPLACE INTO maintenance (id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version) VALUES (1, ?, NULL, NULL, ?)",
      now + this.config.cleanupIntervalMs,
      SCHEMA_VERSION,
    );
    this.seedGeneralRoom({ last_log_id: 0, history_floor: 1, last_commit_ms: 0 }, now);
  }

  /** True when the object holds data from another schema version. */
  requiresReset(): boolean {
    const version = this.readSchemaVersion();
    return version !== 0 && version !== SCHEMA_VERSION;
  }

  /**
   * Wipe every SQLite table and key-value entry (identities, credentials,
   * passkey sessions, chat, limiter windows) and initialize a fresh schema.
   * Used whenever the stored schema version differs from this code's, in
   * either direction; there is no data migration.
   *
   * The guest-number high-water mark is carried over, so a guest ID is never
   * reissued across a reset (a wipe does not restart guests at `guest_1`).
   * Besides it, only the current UTC day's resource reservations are carried
   * over, when the old schema's budget row is readable, so a deploy cannot replenish the
   * daily SQL allowance the platform has already metered. The fresh schema's
   * bootstrap reservation is added to that row without a capacity check, so
   * the reset itself can never fail on, or be blocked by, an exhausted budget;
   * an exhausted day simply stays exhausted until UTC midnight. The
   * accounting-unsafe latch is not carried: a reset is the operator's recovery
   * path for it. Callers must hold the object's input gate (the runtime uses
   * blockConcurrencyWhile) so no request observes the empty storage.
   */
  async resetStorage(): Promise<void> {
    const deleteAll = this.durableStorage?.deleteAll;
    if (typeof deleteAll !== "function") throw new Error("storage reset requires deleteAll()");
    const day = dayFor(Math.max(this.clock.now(), this.lastEffectiveMs));
    let carried: RawBudgetRow | null = null;
    try {
      carried = this.rawRows<RawBudgetRow>(
        `SELECT day, reads_reserved, writes_reserved, frames_reserved,
            admissions_reserved, posts_reserved, registrations_reserved,
            foreground_reads, foreground_writes, maintenance_reads, maintenance_writes
         FROM resource_budgets WHERE day = ? LIMIT 1`,
        day,
      )[0] ?? null;
    } catch {
      // An unreadable old budget table carries nothing.
    }
    let guestNumberMark = 0;
    try {
      guestNumberMark = this.metaNumber(META_GUEST_NUMBER_MARK);
    } catch {
      // An unreadable old meta table carries no guest numbers.
    }
    await deleteAll.call(this.durableStorage);
    this.initialized = false;
    this.accountingUnsafe = false;
    this.accountingUnsafePersisted = false;
    this.accountingUnsafePending = false;
    this.lastEffectiveMs = 0;
    this.scheduledAlarmAt = undefined;
    this.initialize();
    if (guestNumberMark > 0) {
      // Guest numbers outlive the wipe, so none is ever reissued. Like the
      // budget row, this is one uncharged control write.
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_GUEST_NUMBER_MARK, String(guestNumberMark));
    }
    if (!carried) return;
    const columns = ["reads_reserved", "writes_reserved", "frames_reserved", "admissions_reserved", "posts_reserved",
      "registrations_reserved", "foreground_reads", "foreground_writes", "maintenance_reads", "maintenance_writes"] as const;
    const values = columns.map((column) => Math.max(0, integerColumn(carried![column])));
    this.transaction(() => {
      this.rawExec(
        `INSERT OR IGNORE INTO resource_budgets (day, ${columns.join(", ")}) VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
        day,
      );
      this.rawExec(
        `UPDATE resource_budgets SET ${columns.map((column) => `${column} = ${column} + ?`).join(", ")} WHERE day = ?`,
        ...values,
        day,
      );
    });
    this.budgetCacheDay = null;
    this.budgetCache = null;
  }

  /** Log the `general` room's creation record as the next server record. */
  private seedGeneralRoom(state: RawLogState, now: number): void {
    const context: CommitContext = { state: { ...state }, commitMs: Math.max(now, state.last_commit_ms), touched: new Map() };
    const logId = this.allocateLogId(context);
    const record = { room_id: ROOM_ID, log_id: idString(logId), title: ROOM_TITLE };
    this.rawExec(
      `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
      ROOM_ID, logId, logId, logId, JSON.stringify({ title: ROOM_TITLE }), context.commitMs, context.commitMs,
    );
    this.rawExec(
      "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, 'room', ?)",
      ROOM_ID, logId, context.commitMs, JSON.stringify(record),
    );
    this.rawExec(
      "INSERT INTO log_state (id, last_log_id, history_floor, last_commit_ms) VALUES (1, ?, ?, ?)",
      logId,
      state.history_floor,
      context.commitMs,
    );
  }

  private readSchemaVersion(): number {
    try {
      const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version' LIMIT 1");
      return rows.length ? integerColumn(rows[0].value) : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such table|no such column|does not exist/i.test(message)) return 0;
      throw error;
    }
  }

  private ensureReady(): void {
    if (!this.initialized) this.initialize();
  }

  private metaValue(key: string): string {
    const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = ? LIMIT 1", key);
    return rows[0]?.value ?? "";
  }

  private rawExec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T> {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const lower = query.trim().toLowerCase();
    if (lower.startsWith("select") || lower.startsWith("pragma") || lower.startsWith("with")) {
      // Do not materialize here: SqlStorageCursor is single-use. rawRows()
      // consumes it exactly once and records the actual count.
      this.observed.reads += Math.max(1, cursor.rowsRead ?? 1);
    } else {
      this.observed.reads += Math.max(0, cursor.rowsRead ?? 0);
      this.observed.writes += Math.max(1, cursor.rowsWritten ?? 1);
    }
    return cursor;
  }

  private rawScript(script: string): void {
    // Cloudflare's cursor executes one statement per call. Keeping the schema
    // text as one readable migration while dispatching each statement avoids
    // relying on a multi-statement extension in local adapters.
    for (const statement of script.split(";")) {
      const query = statement.trim();
      if (query) this.rawExec(query);
    }
  }

  private rawRows<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.sql.exec<T>(query, ...bindings);
    const rows = cursorRows(cursor);
    this.observed.reads += Math.max(1, cursor.rowsRead ?? rows.length);
    return rows;
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionSync && !this.inTransaction) {
      // Track the native transaction explicitly.  An accounting assertion can
      // fire before the callback returns; its marker must be written only
      // after transactionSync has rolled the user mutation back.
      this.inTransaction = true;
      try {
        const result = this.transactionSync(fn);
        this.inTransaction = false;
        this.persistAccountingUnsafeMarker();
        return result;
      } catch (error) {
        this.inTransaction = false;
        this.persistAccountingUnsafeMarker();
        throw error;
      }
    }
    // The native Workers SQL API forbids issuing BEGIN/COMMIT through
    // sql.exec. A SQL-only adapter is provided for pure unit tests; it runs
    // synchronously and leaves transaction atomicity to that adapter.
    if (this.inTransaction) throw new Error("nested storage transaction");
    this.inTransaction = true;
    try {
      const result = fn();
      this.inTransaction = false;
      this.persistAccountingUnsafeMarker();
      return result;
    } catch (error) {
      this.inTransaction = false;
      this.persistAccountingUnsafeMarker();
      throw error;
    }
  }

  /**
   * An overrun is an authority failure, rather than an operation-local error.
   * Keep the latch in memory immediately and persist it after any enclosing
   * native transaction has rolled back.  The write is deliberately outside
   * the failed transaction so a rollback cannot erase the only durable stop.
   */
  private persistAccountingUnsafeMarker(): void {
    if (!this.accountingUnsafe || this.accountingUnsafePersisted || this.inTransaction) return;
    try {
      this.rawExec(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
        META_ACCOUNTING_UNSAFE,
        "1",
      );
      this.accountingUnsafePersisted = true;
      this.accountingUnsafePending = false;
    } catch {
      // The in-memory latch remains closed. A native storage failure may also
      // prevent the marker write; callers still fail closed for this object,
      // and the runtime will force a fresh recovery attempt rather than reuse
      // uncertain accounting.
      this.accountingUnsafePending = true;
    }
  }

  private markAccountingUnsafe(): void {
    this.accountingUnsafe = true;
    this.accountingUnsafePending = true;
    this.persistAccountingUnsafeMarker();
  }

  /** Return the monotonic effective clock used for retention and quotas. */
  private effectiveNow(candidate: number): number {
    if (!Number.isFinite(candidate) || candidate < 0) throw new StoreError("internal_error", "invalid server clock");
    let previous = 0;
    try {
      const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = ? LIMIT 1", META_EFFECTIVE_NOW);
      previous = rows.length ? Number(rows[0].value) : 0;
    } catch (error) {
      // During the initial schema batch _meta has just been created but the
      // marker is not inserted yet. Other SQLite failures are real failures.
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such table/i.test(message)) throw error;
    }
    if (!Number.isFinite(previous) || previous < 0) previous = 0;
    const effective = Math.max(Math.trunc(candidate), Math.trunc(previous));
    this.lastEffectiveMs = Math.max(this.lastEffectiveMs, effective);
    if (effective > previous) {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_EFFECTIVE_NOW, String(effective));
    }
    return effective;
  }

  private normalizeCost(cost: CostEstimate = {}): BudgetCost {
    return {
      reads: Math.max(0, Math.ceil(cost.reads ?? 0)),
      writes: Math.max(0, Math.ceil(cost.writes ?? 0)),
      frames: Math.max(0, Math.ceil(cost.frames ?? 0)),
      admissions: Math.max(0, Math.ceil(cost.admissions ?? 0)),
      posts: Math.max(0, Math.ceil(cost.posts ?? 0)),
      registrations: Math.max(0, Math.ceil(cost.registrations ?? 0)),
    };
  }

  private budgetRow(day: string): RawBudgetRow {
    const rows = this.rawRows<RawBudgetRow>(
      `SELECT day, reads_reserved, writes_reserved, frames_reserved,
          admissions_reserved, posts_reserved, registrations_reserved,
          foreground_reads, foreground_writes, maintenance_reads, maintenance_writes
       FROM resource_budgets WHERE day = ? LIMIT 1`,
      day,
    );
    if (rows.length) return rows[0];
    this.rawExec(
      `INSERT INTO resource_budgets
       (day, reads_reserved, writes_reserved, frames_reserved, admissions_reserved,
        posts_reserved, registrations_reserved, foreground_reads, foreground_writes,
        maintenance_reads, maintenance_writes)
       VALUES (?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)`,
      day,
    );
    return {
      day,
      reads_reserved: 0,
      writes_reserved: 0,
      frames_reserved: 0,
      admissions_reserved: 0,
      posts_reserved: 0,
      registrations_reserved: 0,
      foreground_reads: 0,
      foreground_writes: 0,
      maintenance_reads: 0,
      maintenance_writes: 0,
    };
  }

  private installBudgetCache(day: string, row: RawBudgetRow): RawBudgetRow {
    this.budgetCacheDay = day;
    this.budgetCache = { ...row };
    return this.budgetCache;
  }

  /** Remove a bounded prefix of stale UTC budget rows after day rollover. */
  private pruneBudgetRows(activeDay: string): void {
    if (this.budgetPruneDay === activeDay) return;
    // Mark the attempt before issuing SQL. A platform error must not make
    // every subsequent request repeat the same maintenance work; the durable
    // reservation remains charged and a later object/day can retry it.
    this.budgetPruneDay = activeDay;
    // Retain the immediately previous day for bounded operator inspection and
    // crash/restart diagnostics. It cannot replenish the active day's lease,
    // because reserveCost always keys authority by the current UTC day.
    const activeStart = Date.parse(`${activeDay}T00:00:00.000Z`);
    const pruneBefore = Number.isFinite(activeStart)
      ? new Date(activeStart - 86_400_000).toISOString().slice(0, 10)
      : activeDay;
    this.rawExec(
      `DELETE FROM resource_budgets
       WHERE day IN (
         SELECT day FROM resource_budgets
         WHERE day < ? ORDER BY day ASC LIMIT ?
       )`,
      pruneBefore,
      BUDGET_PRUNE_BATCH,
    );
  }

  private reservationCost(costInput: CostEstimate, day: string): BudgetCost {
    const cost = this.normalizeCost(costInput);
    // A reservation includes its own bounded control work: effective-clock
    // read/write, budget-row lookup/creation, and the durable counter update.
    // Keep fixed headroom in every class so read-only callers still pay for
    // the bookkeeping writes they cause.
    cost.reads = Math.max(1, cost.reads + 8);
    cost.writes = Math.max(1, cost.writes + 8);
    if (this.budgetHandoverPending) {
      cost.reads += 8;
      cost.writes += 8;
    }
    if (this.budgetPruneDay !== day) {
      cost.reads += BUDGET_PRUNE_RESERVATION_READS;
      cost.writes += BUDGET_PRUNE_RESERVATION_WRITES;
    }
    return cost;
  }

  private checkBudgetCost(cost: BudgetCost, maintenance: boolean, candidateTime: number): void {
    const row = this.budgetCache!;
    const readCeiling = maintenance ? this.config.sqlReadsPerDay : this.config.foregroundReadsPerDay;
    const writeCeiling = maintenance ? this.config.sqlWritesPerDay : this.config.foregroundWritesPerDay;
    const readUsed = row.reads_reserved + cost.reads;
    const writeUsed = row.writes_reserved + cost.writes;
    const reserveReads = maintenance ? this.config.maintenanceReadsPerDay - MAINTENANCE_CONTROL_READS : 0;
    const reserveWrites = maintenance ? this.config.maintenanceWritesPerDay - MAINTENANCE_CONTROL_WRITES : 0;
    if (readUsed > this.config.sqlReadsPerDay || (!maintenance && row.foreground_reads + cost.reads > readCeiling) ||
        (maintenance && row.maintenance_reads + cost.reads > reserveReads) ||
        writeUsed > this.config.sqlWritesPerDay || (!maintenance && row.foreground_writes + cost.writes > writeCeiling) ||
        (maintenance && row.maintenance_writes + cost.writes > reserveWrites)) {
      const next = Math.max(1000, 86_400_000 - (candidateTime % 86_400_000));
      const day = dayFor(candidateTime);
      if (this.budgetStopLoggedDay !== day) {
        this.budgetStopLoggedDay = day;
        console.warn(JSON.stringify({ event: "daily_budget_exhausted", ...row,
          requested_reads: cost.reads, requested_writes: cost.writes, maintenance,
          foreground_read_limit: this.config.foregroundReadsPerDay,
          foreground_write_limit: this.config.foregroundWritesPerDay,
          total_read_limit: this.config.sqlReadsPerDay, total_write_limit: this.config.sqlWritesPerDay }));
      }
      throw new StoreError("retry_after", maintenance ? "Maintenance budget exhausted" : "Demo capacity reached", {
        retryAfterMs: next,
        data: { reason: "daily_budget" },
      });
    }
  }

  /** Advisory capacity check: no SQL, reservations, or durable clock updates. */
  checkConnectionBudget(now = this.clock.now()): void {
    this.ensureReady();
    if (this.accountingUnsafe) throw new StoreError("internal_error", "storage accounting is unsafe; admission is closed");
    if (!this.config.admissionEnabled) throw new StoreError("denied", "Demo admission is closed");
    const candidateTime = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const day = dayFor(candidateTime);
    // The next real admission initializes a new day's budget. Never carry a
    // previous day's exhausted allowance into a new day's diagnostic response.
    if (!this.budgetCache || this.budgetCacheDay !== day) return;
    this.checkBudgetCost(this.reservationCost({ reads: 64, writes: 32, admissions: 1 }, day), false, candidateTime);
  }

  private reserveCost(costInput: CostEstimate, maintenance = false, now = this.clock.now()): BudgetCost {
    this.ensureReady();
    if (this.accountingUnsafe) {
      throw new StoreError("internal_error", "storage accounting is unsafe; admission is closed");
    }
    const candidateTime = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const candidateDay = dayFor(candidateTime);
    try {
      if (this.budgetCacheDay !== candidateDay || !this.budgetCache) {
        // This is the one bounded wake/day rollover read. Once loaded, the
        // synchronous DO serialization makes the cache authoritative until
        // the next day, so repeated denied work performs no SQL at all.
        this.installBudgetCache(candidateDay, this.budgetRow(candidateDay));
        this.budgetHandoverPending = true;
      }
      const pruning = this.budgetPruneDay !== candidateDay;
    const cost = this.reservationCost(costInput, candidateDay);
    this.checkBudgetCost(cost, maintenance, candidateTime);
    const row = this.budgetCache!;
    const reservationCursor = this.rawExec(
      `UPDATE resource_budgets SET
        reads_reserved = reads_reserved + ?, writes_reserved = writes_reserved + ?,
        frames_reserved = frames_reserved + ?, admissions_reserved = admissions_reserved + ?,
        posts_reserved = posts_reserved + ?, registrations_reserved = registrations_reserved + ?,
        foreground_reads = foreground_reads + ?, foreground_writes = foreground_writes + ?,
        maintenance_reads = maintenance_reads + ?, maintenance_writes = maintenance_writes + ?
       WHERE day = ?`,
      cost.reads,
      cost.writes,
      cost.frames,
      cost.admissions,
      cost.posts,
      cost.registrations,
      maintenance ? 0 : cost.reads,
      maintenance ? 0 : cost.writes,
      maintenance ? cost.reads : 0,
      maintenance ? cost.writes : 0,
      candidateDay,
    );
    if (reservationCursor.rowsWritten !== undefined && reservationCursor.rowsWritten < 1) {
      throw new StoreError("internal_error", "budget reservation did not update durable state");
    }
    const nextRow: RawBudgetRow = {
      ...row,
      day: candidateDay,
      reads_reserved: row.reads_reserved + cost.reads,
      writes_reserved: row.writes_reserved + cost.writes,
      frames_reserved: row.frames_reserved + cost.frames,
      admissions_reserved: row.admissions_reserved + cost.admissions,
      posts_reserved: row.posts_reserved + cost.posts,
      registrations_reserved: row.registrations_reserved + cost.registrations,
      foreground_reads: row.foreground_reads + (maintenance ? 0 : cost.reads),
      foreground_writes: row.foreground_writes + (maintenance ? 0 : cost.writes),
      maintenance_reads: row.maintenance_reads + (maintenance ? cost.reads : 0),
      maintenance_writes: row.maintenance_writes + (maintenance ? cost.writes : 0),
    };
    this.installBudgetCache(candidateDay, nextRow);
    this.budgetHandoverPending = false;
    // Persist the monotonic effective clock only after the cached capacity
    // check has accepted the reservation; rejected floods therefore do not
    // issue an uncharged meta write.
    this.effectiveNow(now);
    if (pruning) this.pruneBudgetRows(candidateDay);
    this.observed.operations += 1;
    this.observed.reservedReads += cost.reads;
    this.observed.reservedWrites += cost.writes;
    return { ...cost, day: candidateDay, maintenance };
    } catch (error) {
      // A reservation SQL failure is itself an accounting uncertainty. Do not
      // leave a stale cache that could grant the same allowance on retry.
      if (!(error instanceof StoreError) || error.code !== "retry_after") this.markAccountingUnsafe();
      throw error;
    }
  }

  /** Spend the maintenance control gap when ordinary work is exhausted. */
  private reserveMaintenanceControl(costInput: CostEstimate, now: number): BudgetCost {
    this.ensureReady();
    if (this.accountingUnsafe) throw new StoreError("internal_error", "storage accounting is unsafe; admission is closed");
    const candidateTime = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const day = dayFor(candidateTime);
    try {
      if (this.budgetCacheDay !== day || !this.budgetCache) {
        this.installBudgetCache(day, this.budgetRow(day));
        this.budgetHandoverPending = true;
      }
    } catch (error) {
      this.markAccountingUnsafe();
      throw error;
    }
    const cost = this.normalizeCost(costInput);
    const reads = Math.max(1, cost.reads);
    const writes = Math.max(1, cost.writes);
    const row = this.budgetCache!;
    if (row.maintenance_reads + reads > this.config.maintenanceReadsPerDay ||
        row.maintenance_writes + writes > this.config.maintenanceWritesPerDay ||
        row.reads_reserved + reads > this.config.sqlReadsPerDay ||
        row.writes_reserved + writes > this.config.sqlWritesPerDay) {
      throw new StoreError("retry_after", "Maintenance control budget exhausted", { retryAfterMs: Math.max(1000, 86_400_000 - (candidateTime % 86_400_000)) });
    }
    let reservationCursor: SqlCursorLike;
    try {
      reservationCursor = this.rawExec(
        `UPDATE resource_budgets SET
          reads_reserved = reads_reserved + ?, writes_reserved = writes_reserved + ?,
          maintenance_reads = maintenance_reads + ?, maintenance_writes = maintenance_writes + ?
         WHERE day = ?`,
        reads,
        writes,
        reads,
        writes,
        day,
      );
    } catch (error) {
      this.markAccountingUnsafe();
      throw error;
    }
    if (reservationCursor.rowsWritten !== undefined && reservationCursor.rowsWritten < 1) {
      this.markAccountingUnsafe();
      throw new StoreError("internal_error", "maintenance reservation did not update durable state");
    }
    this.installBudgetCache(day, {
      ...row,
      reads_reserved: row.reads_reserved + reads,
      writes_reserved: row.writes_reserved + writes,
      maintenance_reads: row.maintenance_reads + reads,
      maintenance_writes: row.maintenance_writes + writes,
    });
    this.budgetHandoverPending = false;
    this.observed.operations += 1;
    this.observed.reservedReads += reads;
    this.observed.reservedWrites += writes;
    return { reads, writes, frames: cost.frames, admissions: cost.admissions, posts: cost.posts, registrations: cost.registrations };
  }

  /** Explicit boundary for runtime operations that do their own SQL. */
  withMeter<T>(kind: "foreground" | "maintenance", cost: CostEstimate, fn: () => T, now = this.clock.now()): T {
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveCost(cost, kind === "maintenance", now);
    try {
      return fn();
    } finally {
      // A platform cursor can reveal more rows than a static estimate
      // predicted. Keep accepted state durable, latch accounting unsafe, and
      // fail closed so an underestimated operation cannot continue.
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  /**
   * Meter a bounded operation which awaits storage outside SQLite (for
   * example, Durable Object key-value storage).  The reservation is made
   * before the first await, so a concurrent request cannot spend the same
   * daily allowance.  KV work has no SQL cursor to reconcile; callers must
   * supply a conservative bound for the complete operation.
   */
  async withMeterAsync<T>(kind: "foreground" | "maintenance", cost: CostEstimate, fn: () => Promise<T>, now = this.clock.now()): Promise<T> {
    // The callback may yield while another input-gated operation performs
    // SQLite work. Do not compare shared observed counters across the await:
    // this reservation already charges the complete bounded external work.
    this.reserveCost(cost, kind === "maintenance", now);
    return await fn();
  }

  private assertReservation(reserved: BudgetCost, beforeReads: number, beforeWrites: number): void {
    const actualReads = this.observed.reads - beforeReads;
    const actualWrites = this.observed.writes - beforeWrites;
    if (actualReads > reserved.reads || actualWrites > reserved.writes) {
      // Set the latch before throwing. If this assertion is inside a native
      // transaction, transaction() persists it after rollback; outside a
      // transaction it is durable immediately.
      this.markAccountingUnsafe();
      throw new StoreError("internal_error", "storage cost exceeded its reservation", {
        data: {
          reserved_reads: reserved.reads,
          reserved_writes: reserved.writes,
          actual_reads: actualReads,
          actual_writes: actualWrites,
        },
      });
    }
  }

  /** The final check on a finished operation: assert it stayed within its reservation, then refund the rest. */
  private settleReservation(reserved: BudgetCost, beforeReads: number, beforeWrites: number): void {
    this.assertReservation(reserved, beforeReads, beforeWrites);
    this.refundUnused(reserved, this.observed.reads - beforeReads, this.observed.writes - beforeWrites);
  }

  /**
   * Credits back what a finished reservation did not use, so the day's budget
   * counts the SQL actually done. The reservation still gated the work up
   * front, so no request can exceed what the ceiling allowed it. The credit is
   * one row update, paid from the reservation it returns: an operation is
   * charged its observed rows plus that one.
   */
  private refundUnused(reserved: BudgetCost, actualReads: number, actualWrites: number): void {
    const row = this.budgetCache;
    if (!reserved.day || !row || this.budgetCacheDay !== reserved.day) return;
    const reads = reserved.reads - actualReads - REFUND_READS;
    const writes = reserved.writes - actualWrites - REFUND_WRITES;
    if (reads <= 0 && writes <= 0) return;
    const creditReads = Math.max(0, reads);
    const creditWrites = Math.max(0, writes);
    const maintenance = reserved.maintenance === true;
    try {
      this.rawExec(
        `UPDATE resource_budgets SET
          reads_reserved = reads_reserved - ?, writes_reserved = writes_reserved - ?,
          foreground_reads = foreground_reads - ?, foreground_writes = foreground_writes - ?,
          maintenance_reads = maintenance_reads - ?, maintenance_writes = maintenance_writes - ?
         WHERE day = ?`,
        creditReads,
        creditWrites,
        maintenance ? 0 : creditReads,
        maintenance ? 0 : creditWrites,
        maintenance ? creditReads : 0,
        maintenance ? creditWrites : 0,
        reserved.day,
      );
    } catch {
      // A failed credit only leaves the day over-charged, which is safe.
      return;
    }
    this.installBudgetCache(reserved.day, {
      ...row,
      reads_reserved: row.reads_reserved - creditReads,
      writes_reserved: row.writes_reserved - creditWrites,
      foreground_reads: row.foreground_reads - (maintenance ? 0 : creditReads),
      foreground_writes: row.foreground_writes - (maintenance ? 0 : creditWrites),
      maintenance_reads: row.maintenance_reads - (maintenance ? creditReads : 0),
      maintenance_writes: row.maintenance_writes - (maintenance ? creditWrites : 0),
    });
  }

  private reserved<T>(cost: CostEstimate, maintenance: boolean, now: number, fn: () => T): T {
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost(cost, maintenance, now);
    try {
      return fn();
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites);
    }
  }

  accountingStatus(): { unsafe: boolean; database_bytes: number | null } {
    return { unsafe: this.accountingUnsafe, database_bytes: this.databaseSize() };
  }

  accountUsageSnapshot(): AccountUsageSnapshot | null {
    this.ensureReady();
    const raw = this.metaValue(META_ACCOUNT_USAGE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<AccountUsageSnapshot>;
      const sampledAt = parsed.sampledAt;
      if (typeof parsed.day !== "string" || typeof sampledAt !== "number" || !Number.isSafeInteger(sampledAt) || sampledAt < 0 ||
        ["workerRequests", "durableObjectRequests", "durableObjectDurationGbSeconds", "sqlRowsRead", "sqlRowsWritten", "storedBytes"].some(key => {
          const value = parsed[key as keyof AccountUsageSnapshot];
          return typeof value !== "number" || !Number.isFinite(value) || value < 0;
        }) || typeof parsed.stop !== "boolean") return null;
      return parsed as AccountUsageSnapshot;
    } catch {
      return null;
    }
  }

  persistAccountUsageSnapshot(snapshot: AccountUsageSnapshot, now = this.clock.now()): void {
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, true, now, () => {
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_ACCOUNT_USAGE, JSON.stringify(snapshot));
    });
  }

  budget(now = this.clock.now()): BudgetSnapshot {
    this.ensureReady();
    const day = dayFor(this.effectiveNow(now));
    const row = this.budgetRow(day);
    return {
      day,
      reads: row.reads_reserved,
      writes: row.writes_reserved,
      frames: row.frames_reserved,
      admissions: row.admissions_reserved,
      posts: row.posts_reserved,
      registrations: row.registrations_reserved,
      foreground_reads: row.foreground_reads,
      foreground_writes: row.foreground_writes,
      maintenance_reads: row.maintenance_reads,
      maintenance_writes: row.maintenance_writes,
    };
  }

  storageAccounting(): {
    reads: number;
    writes: number;
    operations: number;
    reservedReads: number;
    reservedWrites: number;
  } {
    return { ...this.observed };
  }

  databaseSize(): number | null {
    const sql = this.durableStorage?.sql as unknown as { databaseSize?: unknown } | undefined;
    return typeof sql?.databaseSize === "number" && Number.isFinite(sql.databaseSize) ? sql.databaseSize : null;
  }

  private ensureGrowthCapacity(additionalBytes: number): void {
    const size = this.databaseSize();
    if (size === null) throw new StoreError("internal_error", "Storage capacity unavailable");
    // workerd's databaseSize subtracts freelist pages, so this is occupied
    // SQLite space, including indexes, rather than the filesystem's high-water
    // size. No unbounded COUNT/SUM scan or VACUUM is needed to observe reuse.
    const paused = this.metaValue("storage_pressure") === "1";
    // Cover snapshot copies, indexed inserts/splits and control rows before
    // entering the transaction. The post-write target check also runs before
    // commit; one unexpectedly large operation cannot cross the hard target.
    const growthAllowance = Math.max(1024 * 1024, Math.max(0, additionalBytes) * 16);
    if (size >= this.config.storageHighWaterBytes || size + growthAllowance > this.config.storageHardTargetBytes) {
      if (!paused) this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('storage_pressure', '1')");
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
    }
    if (paused) {
      if (size > this.config.storageLowWaterBytes) throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
      this.rawExec("UPDATE _meta SET value = '0' WHERE key = 'storage_pressure'");
    }
  }

  private assertStorageTarget(): void {
    const size = this.databaseSize();
    if (size === null || size > this.config.storageHardTargetBytes) {
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs });
    }
  }

  private logState(): RawLogState {
    const rows = this.rawRows<RawLogState>(
      "SELECT last_log_id, history_floor, last_commit_ms FROM log_state WHERE id = 1 LIMIT 1",
    );
    if (!rows.length) throw new StoreError("internal_error", "log state is missing");
    return { ...rows[0] };
  }

  private roomRow(roomId: string): RawRoomRow | null {
    const rows = this.rawRows<RawRoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE room_id = ? LIMIT 1`, roomId);
    return rows[0] ?? null;
  }

  /**
   * The complete room record with this server's delivery fields. The intro
   * message is embedded as its current retained snapshot when available.
   */
  private roomRecord(row: RawRoomRow, floor: number, intro?: { snapshot_json: string | null; latest_log_id: number | null } | null): RoomRecord {
    const fields = parseJson<{ title?: unknown; ext?: unknown }>(row.fields_json, {});
    const record: Record<string, unknown> = { room_id: row.room_id, log_id: idString(row.record_log_id) };
    if (row.parent_room_id !== null) record.parent_room_id = row.parent_room_id;
    if (typeof fields.title === "string") record.title = fields.title;
    if (row.intro_message_id !== null) {
      record.intro_message = intro && intro.snapshot_json !== null && intro.latest_log_id !== null && intro.latest_log_id >= floor
        ? parseJson<Record<string, unknown>>(intro.snapshot_json)
        : { message_id: row.intro_message_id };
    }
    if (isPlainObject(fields.ext)) record.ext = fields.ext;
    record.latest_log_id = idString(row.latest_log_id);
    record.history_log_id = roomHistoryLogId(row, floor);
    return record as unknown as RoomRecord;
  }

  private introFor(row: RawRoomRow): { snapshot_json: string | null; latest_log_id: number | null } | null {
    if (row.intro_message_id === null) return null;
    const message = this.currentMessage(row.intro_message_id);
    return message ? { snapshot_json: message.snapshot_json, latest_log_id: message.latest_log_id } : null;
  }

  /** Reads reserved for listing every room, bounded by the calibrated thread cap. */
  private roomListingReads(): number {
    // One room row plus one indexed intro-message lookup per room, with slack
    // for index pages; test/accounting.integration.test.ts measures the cap.
    return 32 + 4 * (MAX_THREAD_LIMIT + 1);
  }

  /**
   * Every visible room record, oldest first, for authentication announcements.
   * Maintenance callers (retention re-announcements) charge the maintenance
   * budget, and may keep only rooms whose history_log_id differs from what it
   * was under an earlier retention floor.
   */
  listRooms(now = this.clock.now(), options: { maintenance?: boolean; changedSinceFloor?: number } = {}): RoomRecord[] {
    this.ensureReady();
    return this.reserved({ reads: this.roomListingReads() }, options.maintenance === true, now, () => {
      const floor = this.logState().history_floor;
      // The rooms table is capped at one top-level room plus the calibrated
      // thread ceiling, so this ordered scan is bounded by that cap.
      const rows = this.rawRows<RawRoomListRow>(
        `SELECT r.room_id, r.parent_room_id, r.created_log_id, r.record_log_id, r.latest_log_id,
            r.intro_message_id, r.fields_json, r.created_ms, r.updated_ms,
            m.snapshot_json AS intro_snapshot_json, m.latest_log_id AS intro_log_id
         FROM rooms r LEFT JOIN message_state m ON m.message_id = r.intro_message_id
         ORDER BY r.created_log_id ASC LIMIT ?`,
        MAX_THREAD_LIMIT + 1,
      );
      const since = options.changedSinceFloor;
      return rows
        .filter((row) => since === undefined || roomHistoryLogId(row, since) !== roomHistoryLogId(row, floor))
        .map((row) => this.roomRecord(row, floor, { snapshot_json: row.intro_snapshot_json, latest_log_id: row.intro_log_id }));
    });
  }

  /** One room's record, or null when the room does not exist. */
  getRoom(roomId: string, now = this.clock.now()): RoomRecord | null {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, now, () => {
      const row = this.roomRow(roomId);
      if (!row) return null;
      return this.roomRecord(row, this.logState().history_floor, this.introFor(row));
    });
  }

  /** The room record for `general` (or another room); throws when missing. */
  getRoomState(roomId = ROOM_ID): RoomRecord {
    const room = this.getRoom(roomId);
    if (!room) throw new StoreError("invalid_params", "unknown room");
    return room;
  }

  /** The server-wide log head and retention floor. */
  logBounds(): { latest_log_id: string; history_floor: string } {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => {
      const state = this.logState();
      return { latest_log_id: idString(state.last_log_id), history_floor: idString(state.history_floor) };
    });
  }

  private identityRow(userId: string): RawIdentityRow | null {
    const rows = this.rawRows<RawIdentityRow>(
      "SELECT user_id, user_handle, name, tier, created_ms, updated_ms FROM identities WHERE user_id = ? LIMIT 1",
      userId,
    );
    return rows[0] ?? null;
  }

  /**
   * A registered user's joined rooms, oldest room first. The user index holds
   * at most one row per existing room plus rows of removed rooms awaiting
   * purge, both capped, and the join with `rooms` hides the latter.
   */
  private userRooms(userId: string): string[] {
    return this.rawRows<{ room_id: string }>(
      `SELECT m.room_id FROM memberships m INDEXED BY memberships_user_idx
       JOIN rooms r ON r.room_id = m.room_id
       WHERE m.user_id = ? ORDER BY r.created_log_id LIMIT ?`,
      userId, MAX_THREAD_LIMIT + 1,
    ).map((row) => row.room_id);
  }

  /** Reads for userRooms(): the user's membership rows, live and awaiting purge, and a room lookup each. */
  private userRoomsReads(): number {
    return 8 + 2 * (MAX_THREAD_LIMIT + 1 + MAX_PURGE_ROOMS);
  }

  getIdentity(userId: string): StoredIdentity | null {
    this.ensureReady();
    return this.reserved({ reads: 16 + this.userRoomsReads() }, false, this.clock.now(), () => {
      const row = this.identityRow(userId);
      if (!row) return null;
      const count = this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM credentials WHERE user_id = ? LIMIT 1", userId)[0];
      const credentialCount = integerColumn(count?.count);
      return {
        userId: row.user_id,
        name: row.name,
        userHandle: row.user_handle,
        credentialCount,
        rooms: this.userRooms(userId),
      };
    });
  }

  /**
   * The registered members of each room (§4.3.1), as `user_id` with the
   * current `name` (`""` when removed), in `user_id` order: at most `limit`
   * per room, read from the room's primary-key range with one identity lookup
   * each. Guests' memberships are not stored; the caller adds connected ones.
   */
  roomMembers(roomIds: readonly string[], limit: number, now = this.clock.now()): Map<string, Array<{ user_id: string; name: string }>> {
    this.ensureReady();
    const ids = [...new Set(roomIds)].slice(0, MAX_THREAD_LIMIT + 1);
    const perRoom = Math.max(0, Math.floor(limit));
    const members = new Map<string, Array<{ user_id: string; name: string }>>();
    if (!ids.length || perRoom === 0) return members;
    return this.reserved({ reads: 8 + ids.length * (4 + 2 * perRoom) }, false, now, () => {
      for (const roomId of ids) {
        const rows = this.rawRows<{ user_id: string; name: string | null }>(
          `SELECT m.user_id, i.name FROM memberships m LEFT JOIN identities i ON i.user_id = m.user_id
           WHERE m.room_id = ? ORDER BY m.user_id LIMIT ?`,
          roomId, perRoom,
        );
        if (rows.length) members.set(roomId, rows.map((row) => ({ user_id: row.user_id, name: row.name ?? "" })));
      }
      return members;
    });
  }

  getCredential(credentialId: string): StoredCredential | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => this.credentialValue(credentialId));
  }

  private credentialValue(credentialId: string): StoredCredential | null {
    const rows = this.rawRows<RawCredentialRow>(
      "SELECT credential_id, user_id, public_key_json, sign_count, transports_json FROM credentials WHERE credential_id = ? LIMIT 1",
      credentialId,
    );
    if (!rows.length) return null;
    const row = rows[0];
    const metadata = parseJson<Record<string, unknown>>(row.public_key_json);
    return {
      credentialId: row.credential_id,
      userId: row.user_id,
      publicKey: typeof metadata.publicKey === "string" ? metadata.publicKey : row.public_key_json,
      counter: row.sign_count,
      ...(Array.isArray(metadata.transports) ? { transports: metadata.transports.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof metadata.deviceType === "string" ? { deviceType: metadata.deviceType } : {}),
      ...(typeof metadata.backedUp === "boolean" ? { backedUp: metadata.backedUp } : {}),
    };
  }

  countIdentities(): number {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => this.metaNumber("identity_count"));
  }

  findDedup(userId: string, requestId: string, now: number): DedupRecord | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, now, () => {
      const effective = this.effectiveNow(now);
      const rows = this.rawRows<RawDedupRow>(
        "SELECT user_id, request_id, digest, result_json, expires_ms FROM accepted_requests WHERE user_id = ? AND request_id = ? AND expires_ms > ? LIMIT 1",
        userId,
        requestId,
        effective,
      );
      if (!rows.length) return null;
      const row = rows[0];
      const result = parseJson<Record<string, unknown>>(row.result_json, {});
      const method = typeof result.__method === "string" ? result.__method : "message";
      delete result.__method;
      return {
        userId: row.user_id,
        requestId: row.request_id,
        digest: row.digest,
        method,
        result,
        expiresAt: row.expires_ms,
      };
    });
  }

  private dedupRow(userId: string, requestId: string, now: number): RawDedupRow | null {
    const rows = this.rawRows<RawDedupRow>(
      "SELECT user_id, request_id, digest, result_json, transition_json, expires_ms FROM accepted_requests WHERE user_id = ? AND request_id = ? AND expires_ms > ? LIMIT 1",
      userId,
      requestId,
      now,
    );
    return rows[0] ?? null;
  }

  private parseEventList(value: string | null | undefined): number[] {
    const parsed = parseJson<unknown[]>(value ?? "[]", []);
    return parsed.filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item));
  }

  private limitRow(scope: string, principalKey: string, now: number): RawLimitRow {
    const rows = this.rawRows<RawLimitRow>(
      `SELECT scope, principal_key, post_events_json, auth_events_json,
          history_events_json, admission_events_json, day, posts_day,
          registrations_day, updated_ms
       FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1`,
      scope,
      principalKey,
    );
    if (rows.length) return rows[0];
    if (this.metaNumber("principal_limit_count") >= this.config.principalLimitCap) {
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: 60_000 });
    }
    this.ensureGrowthCapacity(4096);
    const day = dayFor(now);
    this.rawExec(
      `INSERT INTO principal_limits
       (scope, principal_key, post_events_json, auth_events_json, history_events_json,
        admission_events_json, day, posts_day, registrations_day, updated_ms)
       VALUES (?, ?, '[]', '[]', '[]', '[]', ?, 0, 0, ?)`,
      scope,
      principalKey,
      day,
      now,
    );
    this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('principal_limit_count', ?)", String(this.metaNumber("principal_limit_count") + 1));
    return {
      scope,
      principal_key: principalKey,
      post_events_json: "[]",
      auth_events_json: "[]",
      history_events_json: "[]",
      admission_events_json: "[]",
      day,
      posts_day: 0,
      registrations_day: 0,
      updated_ms: now,
    };
  }

  private updateLimitRow(row: RawLimitRow, updates: Partial<RawLimitRow>, now: number): void {
    const next = { ...row, ...updates, updated_ms: now };
    this.rawExec(
      `UPDATE principal_limits SET post_events_json = ?, auth_events_json = ?,
        history_events_json = ?, admission_events_json = ?, day = ?,
        posts_day = ?, registrations_day = ?, updated_ms = ?
       WHERE scope = ? AND principal_key = ?`,
      next.post_events_json,
      next.auth_events_json,
      next.history_events_json,
      next.admission_events_json,
      next.day,
      next.posts_day,
      next.registrations_day,
      next.updated_ms,
      next.scope,
      next.principal_key,
    );
  }

  private currentEvents(row: RawLimitRow, field: "post" | "auth" | "history" | "admission", now: number): number[] {
    const key = `${field}_events_json` as keyof RawLimitRow;
    const events = this.parseEventList(typeof row[key] === "string" ? row[key] as string : "[]");
    const cutoff = now - POST_WINDOW_MS;
    return events.filter((event) => event > cutoff && event <= now);
  }

  private checkWindow(events: number[], allowance: number, now: number, message: string): void {
    if (events.length >= allowance) {
      const oldest = Math.min(...events);
      const retry = Math.max(1000, oldest + POST_WINDOW_MS - now);
      throw new StoreError("retry_after", message, { retryAfterMs: retry });
    }
  }

  private chargePosting(input: { userId: string; tier: Tier; ipKey: string; now: number }): void {
    const { userId, tier, ipKey, now } = input;
    const principal = tier === "registered" ? `user:${userId}` : `anonymous:${ipKey}`;
    const rows = [
      this.limitRow("post", principal, now),
      this.limitRow("post", `ip:${ipKey}`, now),
      this.limitRow("post", "global", now),
    ];
    const events = rows.map((row) => this.currentEvents(row, "post", now));
    const daily = dayFor(now);
    let retryAfterMs = 0;
    let reason = "Posting limit reached";
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const previousEvents = events[index];
      const allowance = index === 0
        ? (tier === "registered" ? this.config.registeredPostsPerMinute : this.config.anonymousPostsPerMinute)
        : index === 1 ? this.config.ipPostsPerMinute : this.config.globalPostsPerMinute;
      const dailyAllowance = index === 0
        ? (tier === "registered" ? this.config.registeredPostsPerDay : this.config.anonymousPostsPerDay)
        : index === 1 ? this.config.ipPostsPerDay : this.config.globalPostsPerDay;
      if (previousEvents.length >= allowance) {
        const retry = Math.max(1, previousEvents[previousEvents.length - allowance] + POST_WINDOW_MS - now);
        if (retry > retryAfterMs) {
          retryAfterMs = retry;
          reason = index === 0 && tier === "anonymous" ? "Guest posting limit reached" : "Posting limit reached";
        }
      }
      const count = row.day === daily ? row.posts_day : 0;
      if (count >= dailyAllowance) {
        const retry = Math.max(1, 86_400_000 - now % 86_400_000);
        if (retry > retryAfterMs) {
          retryAfterMs = retry;
          reason = index === 2 ? "Demo is read-only until daily reset" : "Daily posting limit reached";
        }
      }
    }
    if (retryAfterMs > 0) throw new StoreError("retry_after", reason, { retryAfterMs });
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const nextEvents = [...events[index], now];
      const dailyCount = row.day === daily ? row.posts_day + 1 : 1;
      this.updateLimitRow(row, {
        post_events_json: JSON.stringify(nextEvents),
        day: daily,
        posts_day: dailyCount,
      }, now);
    }
  }

  private chargeEvent(
    scope: string,
    principalKey: string,
    field: "auth" | "history" | "admission",
    now: number,
    allowance: number,
    message: string,
  ): void {
    const row = this.limitRow(scope, principalKey, now);
    const events = this.currentEvents(row, field, now);
    this.checkWindow(events, allowance, now, message);
    const key = `${field}_events_json` as keyof RawLimitRow;
    this.updateLimitRow(row, { [key]: JSON.stringify([...events, now]) } as Partial<RawLimitRow>, now);
  }

  reserveAuthAttempt(input: { ipKey: string; now: number }): void {
    this.ensureReady();
    // Frames are reserved by reserveFrames at the websocket boundary.  Keep
    // the auth operation's SQL reservation separate so one frame is not
    // charged twice.
    this.reserved({ ...this.config.authCost, frames: 0, reads: Math.max(32, this.config.authCost.reads ?? 0), writes: Math.max(16, this.config.authCost.writes ?? 0) }, false, input.now, () => {
      const effective = this.effectiveNow(input.now);
      this.transaction(() => {
        this.chargeEvent("auth", `ip:${input.ipKey}`, "auth", effective, this.config.authAttemptsPerIpMinute, "Authentication attempts limited");
      });
    });
  }

  /**
   * Durably reserve the next `count` guest numbers and return them as the
   * half-open range [first, limit). The stored high-water mark advances by
   * `count` in one write, so numbers handed out from the range are never
   * reissued, even after a restart, eviction, or hibernation wake loses the
   * caller's in-memory range: the next call reserves past it, leaving a gap.
   * Synchronous, like every Store call, so callers in one object cannot
   * interleave two reservations.
   */
  reserveGuestNumbers(count: number, now = this.clock.now()): { first: number; limit: number } {
    this.ensureReady();
    if (!Number.isSafeInteger(count) || count <= 0) throw new StoreError("invalid_params", "guest number block must be a positive safe integer");
    return this.reserved(GUEST_NUMBER_BLOCK_COST, false, now, () => this.transaction(() => {
      const mark = this.metaNumber(META_GUEST_NUMBER_MARK);
      if (mark > MAX_SAFE_ID - count - 1) throw new StoreError("internal_error", "guest numbers are exhausted");
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_GUEST_NUMBER_MARK, String(mark + count));
      return { first: mark + 1, limit: mark + count + 1 };
    }));
  }

  reserveHistory(input: { userId: string; ipKey: string; now: number }): void {
    this.ensureReady();
    this.reserved({ ...this.config.historyCost, reads: Math.max(32, this.config.historyCost.reads ?? 0), writes: Math.max(16, this.config.historyCost.writes ?? 0) }, false, input.now, () => {
      const effective = this.effectiveNow(input.now);
      this.transaction(() => {
        this.chargeEvent("history", `user:${input.userId}`, "history", effective, this.config.historyRequestsPerUserMinute, "History request limit reached");
        this.chargeEvent("history", `ip:${input.ipKey}`, "history", effective, this.config.historyRequestsPerIpMinute, "History request limit reached");
      });
    });
  }

  reserveFrames(input: { ipKey: string; now: number; count?: number }): void {
    this.ensureReady();
    const count = Math.max(1, Math.floor(input.count ?? 1));
    if (count > this.config.framesPerIpMinute || count > this.config.processedFramesPerDay) {
      throw new StoreError("invalid_params", "frame reservation is too large");
    }
    this.reserved({ reads: 16 + count * 4, writes: 16, frames: count }, false, input.now, () => {
      const effective = this.effectiveNow(input.now);
      this.transaction(() => {
        const row = this.limitRow("frames", `ip:${input.ipKey}`, effective);
        const events = this.currentEvents(row, "auth", effective);
        if (events.length + count > this.config.framesPerIpMinute) {
          const oldest = Math.min(...events);
          const retry = Math.max(1000, oldest + POST_WINDOW_MS - effective);
          throw new StoreError("retry_after", "Frame rate limit reached", { retryAfterMs: retry });
        }
        // Reuse auth_events_json as a bounded generic frame-event lane; the
        // scope separates it from authentication rows.
        this.updateLimitRow(row, { auth_events_json: JSON.stringify([...events, ...Array.from({ length: count }, () => effective)]) }, effective);
        const global = this.limitRow("frames", "global", effective);
        const day = dayFor(effective);
        const globalCount = global.day === day ? global.posts_day : 0;
        if (globalCount + count > this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000 });
        }
        this.updateLimitRow(global, { day, posts_day: globalCount + count }, effective);
      });
    });
  }

  private chargeRegistration(ipKey: string, now: number): void {
    const day = dayFor(now);
    const ip = this.limitRow("registration", `ip:${ipKey}`, now);
    const global = this.limitRow("registration", "global", now);
    const ipCount = ip.day === day ? ip.registrations_day : 0;
    const globalCount = global.day === day ? global.registrations_day : 0;
    const retryAfterMs = Math.max(1, 86_400_000 - now % 86_400_000);
    if (ipCount >= this.config.registrationsPerIpDay) {
      throw new StoreError("retry_after", "Registration limit reached for this network", { retryAfterMs });
    }
    if (globalCount >= this.config.registrationsPerDay) {
      throw new StoreError("retry_after", "Registration limit reached", { retryAfterMs });
    }
    this.updateLimitRow(ip, { day, registrations_day: ipCount + 1 }, now);
    this.updateLimitRow(global, { day, registrations_day: globalCount + 1 }, now);
  }

  /**
   * Registers an identity and its credential. The identity starts in the
   * given rooms that still exist (the guest's it replaces, or `general`), and
   * each start is a logged membership (§4.3.2), returned in `broadcasts` for
   * the caller to deliver to the rooms' members.
   */
  registerIdentity(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
    /** The rooms the new identity starts in, such as the guest's it replaces. */
    rooms?: readonly string[];
  }): StoredIdentity & { broadcasts: Broadcast[] } {
    this.ensureReady();
    const { credential } = input;
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    // The starting rooms are checked against the capped rooms table, and each
    // one takes a membership row and a logged membership record.
    const rooms = MAX_THREAD_LIMIT + 1;
    const reservation = this.reserveCost({ reads: 128 + 2 * rooms, writes: 64 + 8 * rooms, registrations: 1 }, false, input.now);
    try {
      if (!input.userId || !input.userHandle || !input.ipKey) throw new StoreError("invalid_params", "registration identity is incomplete");
      ensureText(input.name, "name", this.config.maxNameBytes);
      if ([...input.name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
      ensureText(credential.credentialId, "credential_id", 16 * 1024);
      ensureText(credential.publicKey, "public_key", 16 * 1024);
      if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
      if (this.credentialValue(credential.credentialId)) throw new StoreError("invalid_params", "credential is already registered");
      if (this.metaNumber("identity_count") >= this.config.registeredIdentityCount) {
        throw new StoreError("denied", "registration_closed");
      }
      this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      const effective = this.effectiveNow(input.now);
      return this.transaction(() => {
        const beforeCommit = <T>(value: T): T => {
          this.assertStorageTarget();
          this.assertReservation(reservation, beforeReads, beforeWrites);
          return value;
        };
        // Recheck all persistent caps in the transaction immediately before the
        // credential is made usable; concurrent verification cannot overrun caps.
        if (this.identityRow(input.userId)) throw new StoreError("invalid_params", "identity already exists");
        if (this.credentialValue(credential.credentialId)) throw new StoreError("invalid_params", "credential is already registered");
        if (this.metaNumber("identity_count") >= this.config.registeredIdentityCount) throw new StoreError("denied", "registration_closed");
        this.chargeRegistration(input.ipKey, effective);
        const joined = this.existingRooms(input.rooms ?? DEFAULT_JOINED_ROOMS);
        const publicKeyMetadata = JSON.stringify({
          publicKey: credential.publicKey,
          ...(credential.transports ? { transports: credential.transports } : {}),
          ...(credential.deviceType ? { deviceType: credential.deviceType } : {}),
          ...(credential.backedUp !== undefined ? { backedUp: credential.backedUp } : {}),
        });
        this.rawExec(
          "INSERT INTO identities (user_id, user_handle, name, tier, created_ms, updated_ms) VALUES (?, ?, ?, 'registered', ?, ?)",
          input.userId,
          input.userHandle,
          input.name,
          effective,
          effective,
        );
        this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('identity_count', ?)", String(this.metaNumber("identity_count") + 1));
        this.rawExec(
          `INSERT INTO credentials
           (credential_id, user_id, public_key_json, sign_count, transports_json, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          credential.credentialId,
          input.userId,
          publicKeyMetadata,
          Math.max(0, Math.floor(credential.counter)),
          credential.transports ? JSON.stringify(credential.transports) : null,
          effective,
          effective,
        );
        const broadcasts: Broadcast[] = [];
        if (joined.length) {
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          const user = recordedUser(input.userId, input.name);
          for (const roomId of joined) {
            this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", roomId, input.userId);
            broadcasts.push(this.logMembership(context, roomId, user, true));
          }
          this.finishCommit(context, startLogId);
        }
        return beforeCommit({
          userId: input.userId,
          name: input.name,
          userHandle: input.userHandle,
          credentialCount: 1,
          rooms: joined,
          broadcasts,
        });
      });
    } finally {
      this.settleReservation(reservation, beforeReads, beforeWrites);
    }
  }

  registerCredential(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
    rooms?: readonly string[];
  }): DomainIdentity {
    const stored = this.registerIdentity(input);
    return { user_id: stored.userId, name: stored.name };
  }

  credentialIdsForUser(userId: string): string[] {
    this.ensureReady();
    return this.reserved({ reads: 32 }, false, this.clock.now(), () => {
      const rows = this.rawRows<{ credential_id: string }>("SELECT credential_id FROM credentials WHERE user_id = ? ORDER BY credential_id LIMIT 16", userId);
      return rows.map((row) => row.credential_id);
    });
  }

  updateCredentialCounter(credentialId: string, counter: number): void {
    if (!Number.isSafeInteger(counter) || counter < 0) throw new StoreError("invalid_params", "invalid credential counter");
    this.ensureReady();
    this.reserved({ reads: 8, writes: 8 }, false, this.clock.now(), () => {
      const now = this.effectiveNow(this.clock.now());
      this.rawExec(
        "UPDATE credentials SET sign_count = CASE WHEN sign_count < ? THEN ? ELSE sign_count END, updated_ms = ? WHERE credential_id = ?",
        counter,
        counter,
        now,
        credentialId,
      );
    });
  }

  reserveConnection(input: { ipKey: string; tier: AuthTier; now: number; userId?: string }): void {
    this.ensureReady();
    if (!this.config.admissionEnabled) throw new StoreError("denied", "Demo admission is closed");
    this.reserved({ reads: 64, writes: 32, admissions: 1 }, false, input.now, () => {
      const now = this.effectiveNow(input.now);
      this.transaction(() => {
        this.chargeEvent("admission", `ip:${input.ipKey}`, "admission", now, this.config.connectionAdmissionsPerIpMinute, "Connection admission limit reached");
        const day = dayFor(now);
        // The daily admission ceiling is global. The per-IP control above is a
        // rolling minute gate; using it as a daily counter would make a quiet
        // IP permanently consume global capacity independently.
        const global = this.limitRow("admission", "global", now);
        const admissions = global.day === day ? global.posts_day : 0;
        if (admissions >= this.config.connectionAdmissionsPerDay) throw new StoreError("retry_after", "Connection admission limit reached", { retryAfterMs: 86_400_000 });
        this.updateLimitRow(global, { day, posts_day: admissions + 1 }, now);
        // Live connection caps are authoritative in ctx.getWebSockets(), which
        // includes closing sockets and survives object hibernation.  Durable
        // open counters become stale after a lost close and can permanently
        // deny admission, so only the durable admission/day and frame budget
        // controls are maintained here.
        const frames = this.limitRow("frames", "global", now);
        const frameCount = frames.day === day ? frames.posts_day : 0;
        if (frameCount >= this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000 });
        }
      });
    });
  }

  releaseConnection(input: { ipKey: string; tier: AuthTier; userId?: string }): void {
    // Intentionally no-op: live sockets are counted from the runtime's
    // authoritative getWebSockets() view.  A close callback can be lost or
    // arrive after a redeploy, so a durable decrement would be less correct
    // than doing no durable open-counter accounting at all.
    void input;
  }

  reserveAdmission(input: { ipKey: string; now: number }): void {
    this.reserveConnection({ ...input, tier: "pending" });
  }

  releaseAdmission(input: { ipKey: string; tier: AuthTier; userId?: string }): void {
    this.releaseConnection(input);
  }

  admission(): AdmissionSnapshot {
    this.ensureReady();
    return this.reserved({ reads: 32, writes: 16 }, false, this.clock.now(), () => {
      const now = this.effectiveNow(this.clock.now());
      const day = dayFor(now);
      const frameRows = this.rawRows<{ day: string; posts_day: number }>(
        "SELECT day, posts_day FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1",
        "frames",
        "global",
      );
      const frames = frameRows.length && frameRows[0].day === day ? integerColumn(frameRows[0].posts_day) : 0;
      return {
        globalFrames: frames,
        globalPosts: this.limitEventCount("post", "global", "post", now),
      };
    });
  }

  private metaNumber(key: string): number {
    const rows = this.rawRows<{ value: string }>("SELECT value FROM _meta WHERE key = ? LIMIT 1", key);
    return rows.length && /^\d+$/.test(rows[0].value) ? Number(rows[0].value) : 0;
  }

  private maintenanceRow(): RawMaintenanceRow {
    const rows = this.rawRows<RawMaintenanceRow>(
      "SELECT id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version FROM maintenance WHERE id = 1 LIMIT 1",
    );
    if (!rows.length) throw new StoreError("internal_error", "maintenance state is missing");
    return rows[0];
  }

  private limitEventCount(scope: string, principalKey: string, field: "post" | "auth" | "history" | "admission", now: number): number {
    const rows = this.rawRows<RawLimitRow>("SELECT post_events_json, auth_events_json, history_events_json, admission_events_json, scope, principal_key, day, posts_day, registrations_day, updated_ms FROM principal_limits WHERE scope = ? AND principal_key = ? LIMIT 1", scope, principalKey);
    return rows.length ? this.currentEvents(rows[0], field, now).length : 0;
  }

  private currentMessage(messageId: string, floor?: number): RawMessageRow | null {
    const rows = this.rawRows<RawMessageRow>(
      "SELECT message_id, room_id, latest_log_id, snapshot_json, author_id FROM message_state WHERE message_id = ? LIMIT 1",
      messageId,
    );
    if (!rows.length) return null;
    if (floor !== undefined && rows[0].latest_log_id < floor) return null;
    return rows[0];
  }

  private identityForMessage(input: StoreMutationInput): Identity {
    const name = typeof input.identity.name === "string" ? input.identity.name : undefined;
    return { user_id: input.identity.user_id, ...(name ? { name } : {}) };
  }

  private normalizedBody(value: unknown): Record<string, unknown> {
    const body = jsonObject(value, "body");
    const text = body.text === undefined ? "" : ensureText(body.text, "body.text", this.config.maxTextBytes);
    // The protocol defaults an omitted format to plain text.
    const format = body.format === undefined ? "plain" : body.format;
    if (format !== "plain" && format !== "markdown") throw new StoreError("invalid_params", "body.format is invalid");
    const embeds = body.embeds === undefined ? [] : body.embeds;
    if (!Array.isArray(embeds)) throw new StoreError("invalid_params", "body.embeds must be an array");
    if (embeds.length > this.config.maxEmbeds) throw new StoreError("too_large", "too many embeds");
    // Who a message mentions is the list its sender gives (§3.5); the server
    // never reads mentions out of text. Duplicates collapse.
    let mentions: string[] | undefined;
    if (body.mentions !== undefined) {
      if (!Array.isArray(body.mentions)) throw new StoreError("invalid_params", "body.mentions must be an array of user_id strings");
      const unique = new Set<string>();
      for (const item of body.mentions) {
        if (typeof item !== "string" || item.length === 0 || utf8Bytes(item) > 256) {
          throw new StoreError("invalid_params", "body.mentions must be an array of user_id strings");
        }
        unique.add(item);
      }
      mentions = [...unique];
    }
    return { ...clone(body), text, format, embeds: clone(embeds), ...(mentions ? { mentions } : {}) };
  }

  /** A new message with no text and no embeds, which is neither logged nor broadcast (§3.5). */
  private emptyNewMessage(params: Record<string, unknown>): boolean {
    if (params.message_id !== undefined || (params.deleted !== undefined && params.deleted !== false) || !isPlainObject(params.body)) return false;
    const body = this.normalizedBody(params.body);
    return body.text === "" && (body.embeds as unknown[]).length === 0;
  }

  /** The given room IDs that still exist, once each and in order. Reads the capped rooms table. */
  private existingRooms(ids: readonly string[]): string[] {
    const known = new Set(this.rawRows<{ room_id: string }>("SELECT room_id FROM rooms LIMIT ?", MAX_THREAD_LIMIT + 1).map((row) => row.room_id));
    return [...new Set(ids)].filter((id) => known.has(id));
  }

  /**
   * Logs one registered user's membership change in a room (§4.3.2): a live
   * record carries one entry, with the user as a recorded object. It advances
   * the room's head like any record. Returns it for delivery to the room's
   * members before and after the change.
   */
  private logMembership(context: CommitContext, roomId: string, user: Identity, joined: boolean): Broadcast {
    const logId = this.allocateLogId(context);
    const record: MembershipRecord = { log_id: idString(logId), room_id: roomId, members: [{ user: clone(user), joined }] };
    this.appendRecord(context, [roomId], "membership", logId, JSON.stringify(record));
    return { method: "membership", params: clone(record) as unknown as Record<string, unknown>, rooms: [roomId] };
  }

  /**
   * Joins or leaves one room for a registered identity, whose rooms last
   * across connections (§4.3.2). Guests' rooms live in their connection and
   * are not logged. A change is one `memberships` row and one logged
   * membership record, and counts as a post; joining or leaving where nothing
   * would change writes nothing. Returns the identity's rooms, the logged
   * record, and the room's record after it.
   */
  changeMembership(input: { userId: string; ipKey: string; roomId: string; join: boolean; now?: number }): {
    rooms: string[]; changed: boolean; membership?: Broadcast; room?: RoomRecord;
  } {
    this.ensureReady();
    const operationNow = input.now ?? this.clock.now();
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    // The three posting limiter rows, the identity and membership rows, the
    // room record, and the user's rooms.
    const reserved = this.reserveCost({ reads: 64 + this.userRoomsReads(), writes: 64, posts: 1 }, false, operationNow);
    try {
      const effective = this.effectiveNow(operationNow);
      if (input.join) this.ensureGrowthCapacity(1024);
      return this.transaction(() => {
        const identity = this.identityRow(input.userId);
        if (!identity) throw new StoreError("denied", "Only registered identities keep rooms");
        const room = this.roomRow(input.roomId);
        if (!room) throw new StoreError("invalid_params", "Unknown room");
        const member = this.rawRows("SELECT user_id FROM memberships WHERE room_id = ? AND user_id = ? LIMIT 1", input.roomId, input.userId).length > 0;
        if (member === input.join) return { rooms: this.userRooms(input.userId), changed: false };
        this.chargePosting({ userId: input.userId, tier: "registered", ipKey: input.ipKey, now: effective });
        if (input.join) this.rawExec("INSERT INTO memberships (room_id, user_id) VALUES (?, ?)", input.roomId, input.userId);
        else this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", input.roomId, input.userId);
        const state = this.logState();
        const startLogId = state.last_log_id;
        const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
        const membership = this.logMembership(context, input.roomId, recordedUser(input.userId, identity.name), input.join);
        this.finishCommit(context, startLogId);
        const updated = { ...room, latest_log_id: Math.max(room.latest_log_id, context.state.last_log_id) };
        const record = this.roomRecord(updated, state.history_floor, this.introFor(updated));
        const rooms = this.userRooms(input.userId);
        this.assertStorageTarget();
        this.assertReservation(reserved, beforeReads, beforeWrites);
        return { rooms, changed: true, membership, room: record };
      });
    } finally {
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  private optionalExt(value: unknown, field = "ext"): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) throw new StoreError("invalid_params", `${field} must be an object`);
    return clone(value);
  }

  /**
   * Validate a bare message reference (`reply_to`, `intro_message`). Only the
   * `message_id` is kept. A new reference must name a retained message; a save
   * that resubmits its current reference unchanged is accepted even after the
   * target has expired, so old replies remain editable.
   */
  private messageReference(value: unknown, field: string, floor: number, options: { self?: string; unchanged?: string } = {}): string | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value) || typeof value.message_id !== "string" || value.message_id.length === 0) {
      throw new StoreError("invalid_params", `${field}.message_id must be a non-empty string`);
    }
    const messageId = ensureText(value.message_id, `${field}.message_id`, 256);
    if (options.self !== undefined && messageId === options.self) throw new StoreError("invalid_params", `${field} cannot name the message itself`);
    if (messageId !== options.unchanged && !this.currentMessage(messageId, floor)) {
      throw new StoreError("invalid_params", `${field} names an unknown or expired message`);
    }
    return messageId;
  }

  private allocateLogId(context: CommitContext): number {
    const state = context.state;
    const candidate = Math.max(Math.trunc(context.commitMs), state.last_log_id + 1, state.history_floor);
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_SAFE_ID) throw new StoreError("internal_error", "log identifier range exhausted");
    state.last_log_id = candidate;
    return candidate;
  }

  /** Append one record to each room whose log it belongs to. */
  private appendRecord(context: CommitContext, roomIds: string[], kind: RecordKind, logId: number, json: string): void {
    for (const roomId of roomIds) {
      this.rawExec(
        "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, ?, ?)",
        roomId, logId, context.commitMs, kind, json,
      );
      context.touched.set(roomId, Math.max(context.touched.get(roomId) ?? 0, logId));
    }
  }

  /** Advance each touched room's head and the server-wide head. */
  private finishCommit(context: CommitContext, startLogId: number): void {
    if (context.state.last_log_id === startLogId) return;
    for (const [roomId, logId] of context.touched) {
      this.rawExec("UPDATE rooms SET latest_log_id = MAX(latest_log_id, ?) WHERE room_id = ?", logId, roomId);
    }
    this.rawExec(
      "UPDATE log_state SET last_log_id = ?, last_commit_ms = ? WHERE id = 1",
      context.state.last_log_id,
      Math.max(context.commitMs, context.state.last_commit_ms),
    );
  }

  /** Create, save, delete, restore, or move a message (section 3.5, §4.2). */
  private commitMessage(input: StoreMutationInput, context: CommitContext, floor: number): StoreMutationResult {
    const params = input.params;
    if (params.log_id !== undefined) throw new StoreError("invalid_params", "log_id is server assigned");
    // Without room_id a message goes to the default room (§3.5).
    const roomId = params.room_id === undefined ? ROOM_ID : params.room_id;
    if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    const messageIdParam = params.message_id;
    if (messageIdParam !== undefined && typeof messageIdParam !== "string") throw new StoreError("invalid_params", "message_id must be a string");
    const current = messageIdParam === undefined ? null : this.currentMessage(ensureText(messageIdParam, "message_id", 256), floor);
    if (messageIdParam !== undefined && !current) throw new StoreError("invalid_params", "unknown or expired message");
    if (current && current.author_id !== input.userId) throw new StoreError("denied", "Only the original author may edit this message");
    if (!this.roomRow(roomId)) throw new StoreError("invalid_params", "unknown room");
    const deleted = params.deleted === undefined ? false : params.deleted;
    if (typeof deleted !== "boolean") throw new StoreError("invalid_params", "deleted must be boolean");
    if (!current && deleted) throw new StoreError("invalid_params", "a message cannot be created deleted");
    const previous = current ? parseJson<MessageSnapshot>(current.snapshot_json) : null;
    const replyId = this.messageReference(params.reply_to, "reply_to", floor, {
      ...(typeof messageIdParam === "string" ? { self: messageIdParam } : {}),
      ...(previous?.reply_to ? { unchanged: previous.reply_to.message_id } : {}),
    });
    let body: Record<string, unknown> | undefined;
    if (!deleted) {
      if (params.body === undefined) throw new StoreError("invalid_params", "message body is required");
      body = this.normalizedBody(params.body);
      if (body.text === "" && (body.embeds as unknown[]).length === 0) throw new StoreError("invalid_params", "message cannot be empty");
    }
    const ext = this.optionalExt(params.ext);
    const from = previous ? previous.from : this.identityForMessage(input);
    if (!from || typeof from.user_id !== "string") throw new StoreError("internal_error", "message author is missing");

    const logId = this.allocateLogId(context);
    const messageId = previous ? previous.message_id : idString(logId);
    // Deletion omits the body from the tombstone; the other client fields keep
    // replacement semantics, so omitted fields are removed.
    const snapshot: MessageSnapshot = { message_id: messageId, log_id: idString(logId), room_id: roomId, from: clone(from) };
    if (body) snapshot.body = body;
    if (replyId !== undefined) snapshot.reply_to = { message_id: replyId };
    if (deleted) snapshot.deleted = true;
    if (ext) snapshot.ext = ext;
    // The size policy bounds client content; the server's prev_log_id and
    // prev_room_id links are added after it.
    if (utf8Bytes(JSON.stringify(snapshot)) > this.config.maxSnapshotBytes) throw new StoreError("too_large", "message snapshot is too large");
    const moved = current !== null && current.room_id !== roomId;
    if (current) snapshot.prev_log_id = idString(current.latest_log_id);
    // After a move the previous snapshot is in the source room's log (§2).
    if (moved) snapshot.prev_room_id = current.room_id;
    const json = JSON.stringify(snapshot);

    // A move belongs to the source and destination logs (§4.1).
    this.appendRecord(context, moved ? [current.room_id, roomId] : [roomId], "message", logId, json);
    this.rawExec(
      `INSERT INTO message_state (message_id, room_id, latest_log_id, snapshot_json, author_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET
         room_id = excluded.room_id,
         latest_log_id = excluded.latest_log_id,
         snapshot_json = excluded.snapshot_json`,
      messageId, roomId, logId, json, from.user_id,
    );
    const broadcasts: Broadcast[] = [{
      method: "message", params: clone(snapshot) as unknown as Record<string, unknown>, rooms: moved ? [current.room_id, roomId] : [roomId],
    }];
    if (moved) {
      // Reactions follow a moved message: one record in the destination with
      // every retained non-empty set. The per-message cap bounds this read.
      const rows = this.rawRows<RawReactionRow>(
        `SELECT message_id, user_id, log_id, from_json, emojis_json FROM reaction_state
         WHERE message_id = ? AND log_id >= ? ORDER BY log_id, user_id LIMIT ?`,
        messageId, floor, this.config.reactionUsersPerMessage,
      );
      if (rows.length) {
        const reactionLogId = this.allocateLogId(context);
        const record: ReactionsRecord = {
          log_id: idString(reactionLogId),
          message_id: messageId,
          room_id: roomId,
          reactions: rows.map((row) => ({ from: parseJson<Identity>(row.from_json), emojis: parseJson<string[]>(row.emojis_json) })),
        };
        this.appendRecord(context, [roomId], "reactions", reactionLogId, JSON.stringify(record));
        // The sets' latest record is now the moved copy; retention follows it.
        this.rawExec("UPDATE reaction_state SET log_id = ? WHERE message_id = ? AND log_id >= ?", reactionLogId, messageId, floor);
        broadcasts.push({ method: "reactions", params: clone(record) as unknown as Record<string, unknown>, rooms: [roomId] });
      }
    }
    return { result: { message_id: messageId }, broadcasts, message: snapshot };
  }

  /** Normalize a reaction set: strings, duplicates collapsed, bounded. */
  private normalizedEmojis(value: unknown): string[] {
    if (!Array.isArray(value)) throw new StoreError("invalid_params", "emojis must be an array");
    const emojis: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0) throw new StoreError("invalid_params", "each emoji must be a non-empty string");
      // eslint-disable-next-line no-control-regex
      if (utf8Bytes(item) > MAX_EMOJI_BYTES || /[\u0000-\u001f\u007f]/.test(item)) {
        throw new StoreError("invalid_params", "emoji is not a single bounded sequence");
      }
      if (!emojis.includes(item)) emojis.push(item);
    }
    if (emojis.length > this.config.reactionEmojisPerUser) throw new StoreError("invalid_params", "too many distinct emoji in one reaction set");
    return emojis;
  }

  /** Replace the caller's reaction set on one message (§4.5). */
  private commitReactions(input: StoreMutationInput, context: CommitContext, floor: number): StoreMutationResult {
    const params = input.params;
    const messageIdParam = params.message_id;
    if (typeof messageIdParam !== "string" || messageIdParam.length === 0) throw new StoreError("invalid_params", "message_id must be a non-empty string");
    const emojis = this.normalizedEmojis(params.emojis);
    const message = this.currentMessage(ensureText(messageIdParam, "message_id", 256), floor);
    if (!message) throw new StoreError("invalid_params", "unknown or expired message");
    const snapshot = parseJson<MessageSnapshot>(message.snapshot_json);
    // Clients hide a tombstone's reactions; the demo stores no new ones.
    if (snapshot.deleted === true && emojis.length) throw new StoreError("invalid_params", "cannot react to a deleted message");
    const existing = this.rawRows<RawReactionRow>(
      "SELECT message_id, user_id, log_id, from_json, emojis_json FROM reaction_state WHERE message_id = ? AND user_id = ? LIMIT 1",
      message.message_id, input.userId,
    )[0];
    const currentSet = existing && existing.log_id >= floor ? parseJson<string[]>(existing.emojis_json, []) : [];
    // An unchanged set produces no record (§4.5 permits no change).
    if (currentSet.length === emojis.length && emojis.every((emoji) => currentSet.includes(emoji))) {
      return { result: {}, broadcasts: [] };
    }
    if (!existing && emojis.length) {
      // Count every stored set, including logically expired ones awaiting
      // cleanup, so the move-time read of this message stays within its cap.
      const count = integerColumn(this.rawRows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM (SELECT 1 FROM reaction_state WHERE message_id = ? LIMIT ?)",
        message.message_id, this.config.reactionUsersPerMessage,
      )[0]?.count);
      if (count >= this.config.reactionUsersPerMessage) throw new StoreError("invalid_params", "reaction limit reached for this message");
    }
    const logId = this.allocateLogId(context);
    const from = this.identityForMessage(input);
    const record: ReactionsRecord = {
      log_id: idString(logId),
      message_id: message.message_id,
      room_id: message.room_id,
      reactions: [{ from, emojis }],
    };
    this.appendRecord(context, [message.room_id], "reactions", logId, JSON.stringify(record));
    if (emojis.length) {
      this.rawExec(
        `INSERT INTO reaction_state (message_id, user_id, log_id, from_json, emojis_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (message_id, user_id) DO UPDATE SET
           log_id = excluded.log_id, from_json = excluded.from_json, emojis_json = excluded.emojis_json`,
        message.message_id, input.userId, logId, JSON.stringify(from), JSON.stringify(emojis),
      );
    } else if (existing) {
      this.rawExec("DELETE FROM reaction_state WHERE message_id = ? AND user_id = ?", message.message_id, input.userId);
    }
    return { result: {}, broadcasts: [{ method: "reactions", params: clone(record) as unknown as Record<string, unknown>, rooms: [message.room_id] }] };
  }

  /**
   * `room_set`: create a thread room or replace a thread room's client fields (§4.3.4).
   * Demo policy: only threads under a top-level room may be created, and only
   * thread rooms may be edited; the permanent `general` room is fixed.
   */
  private commitRoom(input: StoreMutationInput, context: CommitContext, floor: number, registered: boolean): StoreMutationResult {
    const params = input.params;
    const roomIdParam = params.room_id;
    if (roomIdParam !== undefined && (typeof roomIdParam !== "string" || roomIdParam.length === 0)) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    const titleParam = params.title;
    if (titleParam !== undefined && typeof titleParam !== "string") throw new StoreError("invalid_params", "title must be a string");
    const ext = this.optionalExt(params.ext);
    // Threads always carry a title so clients that ignore parent_room_id
    // still render them (section 3.4).
    const title = typeof titleParam === "string" && titleParam.trim() !== "" ? titleParam : DEFAULT_THREAD_TITLE;
    const fields: Record<string, unknown> = { title, ...(ext ? { ext } : {}) };

    let row: RawRoomRow;
    let logId: number;
    if (roomIdParam === undefined) {
      const parentId = params.parent_room_id;
      if (parentId === undefined) throw new StoreError("denied", "Only threads may be created on this demo");
      if (typeof parentId !== "string" || parentId.length === 0) throw new StoreError("invalid_params", "parent_room_id must be a non-empty string");
      const parent = this.roomRow(parentId);
      if (!parent) throw new StoreError("invalid_params", "unknown parent_room_id");
      if (parent.parent_room_id !== null) throw new StoreError("denied", "Threads cannot be nested on this demo");
      if (this.metaNumber("thread_count") >= this.config.maxThreads) throw new StoreError("denied", "thread_limit");
      const introId = this.messageReference(params.intro_message, "intro_message", floor);
      this.checkRoomFields(fields, introId);
      logId = this.allocateLogId(context);
      const roomId = idString(logId);
      const fieldsJson = JSON.stringify(fields);
      this.rawExec(
        `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        roomId, parentId, logId, logId, logId, introId ?? null, fieldsJson, context.commitMs, context.commitMs,
      );
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('thread_count', ?)", String(this.metaNumber("thread_count") + 1));
      row = {
        room_id: roomId, parent_room_id: parentId, created_log_id: logId, record_log_id: logId, latest_log_id: logId,
        intro_message_id: introId ?? null, fields_json: fieldsJson, created_ms: context.commitMs, updated_ms: context.commitMs,
      };
    } else {
      const existing = this.roomRow(roomIdParam);
      if (!existing) throw new StoreError("invalid_params", "unknown room");
      if (existing.parent_room_id === null) throw new StoreError("denied", "Top-level rooms cannot be edited on this demo");
      // parent_room_id is fixed at creation; a submitted value is ignored.
      const introId = this.messageReference(params.intro_message, "intro_message", floor, existing.intro_message_id === null ? {} : { unchanged: existing.intro_message_id });
      this.checkRoomFields(fields, introId);
      logId = this.allocateLogId(context);
      const fieldsJson = JSON.stringify(fields);
      this.rawExec(
        "UPDATE rooms SET record_log_id = ?, latest_log_id = ?, intro_message_id = ?, fields_json = ?, updated_ms = ? WHERE room_id = ?",
        logId, logId, introId ?? null, fieldsJson, context.commitMs, existing.room_id,
      );
      row = { ...existing, record_log_id: logId, latest_log_id: logId, intro_message_id: introId ?? null, fields_json: fieldsJson, updated_ms: context.commitMs };
    }
    const created = roomIdParam === undefined;
    // Delivery fields describe a client's view and are not logged.
    const { latest_log_id: _latest, history_log_id: _history, ...logged } = this.roomRecord(row, floor, this.introFor(row));
    void _latest; void _history;
    this.rawExec(
      "INSERT INTO records (room_id, log_id, commit_ms, kind, record_json) VALUES (?, ?, ?, 'room', ?)",
      row.room_id, logId, context.commitMs, JSON.stringify(logged),
    );
    // Creating a room joins its creator (§4.3.4). A registered creator keeps
    // the room, and the join is logged after the room record; a guest's lives
    // in its connection.
    let membership: Broadcast | undefined;
    if (created && registered) {
      this.rawExec("INSERT OR IGNORE INTO memberships (room_id, user_id) VALUES (?, ?)", row.room_id, input.userId);
      membership = this.logMembership(context, row.room_id, recordedUser(input.userId, input.identity.name), true);
      row = { ...row, latest_log_id: Number(membership.params.log_id) };
      // The new room's head is the membership; finishCommit writes it.
      context.touched.set(row.room_id, row.latest_log_id);
    }
    const record = this.roomRecord(row, floor, this.introFor(row));
    // Room records are not broadcast: the caller sends room_update (§4.3.3).
    return { result: { room_id: row.room_id }, broadcasts: [], room: record, created, ...(membership ? { membership } : {}) };
  }

  private checkRoomFields(fields: Record<string, unknown>, introId: string | undefined): void {
    const serialized = JSON.stringify({ ...fields, ...(introId !== undefined ? { intro_message: { message_id: introId } } : {}) });
    if (utf8Bytes(serialized) > this.config.maxThreadMetadataBytes) throw new StoreError("too_large", "room metadata is too large");
  }

  /** A `me` name change; `""` removes the name. Avatars and ext are not stored. */
  private commitMeMutation(input: StoreMutationInput, now: number): StoreMutationResult {
    const name = input.params.name;
    if (typeof name !== "string") throw new StoreError("invalid_params", "name must be a string");
    ensureText(name, "name", this.config.maxNameBytes);
    if ([...name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
    const existing = this.identityRow(input.userId);
    if (!existing) throw new StoreError("denied", "Only registered users may change their name");
    this.rawExec("UPDATE identities SET name = ?, updated_ms = ? WHERE user_id = ?", name, now, input.userId);
    return { result: { name }, broadcasts: [] };
  }

  private commitStoredResult(
    userId: string,
    requestId: string | undefined,
    digest: string,
    method: string,
    result: Record<string, unknown>,
    expiresAt: number,
  ): void {
    if (requestId === undefined) return;
    const storedResult = { ...result, __method: method };
    this.rawExec(
      `INSERT INTO accepted_requests
       (user_id, request_id, digest, result_json, transition_json, expires_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, request_id) DO UPDATE SET
         digest = excluded.digest,
         result_json = excluded.result_json,
         transition_json = excluded.transition_json,
         expires_ms = excluded.expires_ms
       WHERE accepted_requests.expires_ms <= ?`,
      userId,
      requestId,
      digest,
      JSON.stringify(storedResult),
      // The original result is sufficient for a retry response: retries are
      // never rebroadcast, so no record copy is retained here.
      null,
      expiresAt,
      expiresAt,
    );
  }

  private deduplicatedCommit(row: RawDedupRow, method: string, digest: string): StoreMutationResult {
    if (row.digest !== digest) throw new StoreError("invalid_params", "request ID was already used for a different operation");
    const stored = parseJson<Record<string, unknown>>(row.result_json, {});
    if (stored.__method !== undefined && stored.__method !== method) throw new StoreError("invalid_params", "request ID was already used for a different method");
    delete stored.__method;
    return { result: stored, broadcasts: [], deduplicated: true };
  }

  private mutationMethod(method: string | undefined): MutationMethod {
    if (method === undefined || method === "message") return "message";
    if (method === "room_set" || method === "reactions" || method === "me") return method;
    throw new StoreError("unsupported", "Unsupported mutation");
  }

  /**
   * One accepted operation: dedup lookup, reservation, then one atomic
   * decision that rechecks quotas, allocates log IDs, writes every record and
   * current state, and records the result. Callers broadcast `broadcasts` in
   * order only after this returns.
   */
  commitMutation(input: StoreMutationInput): StoreMutationResult {
    this.ensureReady();
    if (!input.userId || !input.ipKey) throw new StoreError("denied", "authentication required");
    if (input.requestId !== undefined) {
      if (typeof input.requestId !== "string" || utf8Bytes(input.requestId) > 128) throw new StoreError("invalid_params", "invalid request ID");
    }
    const method = this.mutationMethod(input.method);
    const operationNow = input.now ?? this.clock.now();
    if (method === "message" && this.emptyNewMessage(input.params)) {
      // Nothing is logged, charged, or recorded; only the room is checked.
      return this.reserved({ reads: 8 }, false, operationNow, () => {
        const roomId = input.params.room_id === undefined ? ROOM_ID : input.params.room_id;
        if (typeof roomId !== "string" || !this.roomRow(roomId)) throw new StoreError("invalid_params", "unknown room");
        return { result: {}, broadcasts: [] };
      });
    }
    const digest = input.digest ?? digestOperation(method, input.params);
    // A retry lookup is deliberately cheaper than a full mutation reserve.
    // Accepted retries must remain available even when posting/storage
    // capacity is exhausted, while still paying their bounded SQL lookup.
    let effective = operationNow;
    if (input.requestId !== undefined) {
      const lookup = this.reserved({ reads: 8, writes: 8 }, false, operationNow, () => {
        const lookupNow = this.effectiveNow(operationNow);
        return {
          now: lookupNow,
          row: this.dedupRow(input.userId, input.requestId!, lookupNow),
        };
      });
      effective = lookup.now;
      if (lookup.row) return this.deduplicatedCommit(lookup.row, method, digest);
    }
    // Conservative floors for the three posting limiter rows, dedup row,
    // records, current state, and room/log bookkeeping. An edit may be a move,
    // which also re-logs the message's capped reaction sets (measured at 158
    // writes); every other mutation measured at most 37. Unused rows are
    // credited back, so the floor only decides admission near the ceiling.
    const mayMove = method === "message" && typeof input.params.message_id === "string";
    const mutationCost = {
      ...this.config.mutationCost,
      reads: Math.max(256, this.config.mutationCost.reads ?? 0),
      writes: Math.max(mayMove ? 256 : 96, this.config.mutationCost.writes ?? 0),
    };
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveCost(mutationCost, false, operationNow);
    try {
      effective = this.effectiveNow(operationNow);
      this.ensureGrowthCapacity(this.config.maxSnapshotBytes);
      return this.transaction(() => {
        const beforeCommit = <T>(value: T): T => {
          // Assert while transactionSync's closure is still open.  If an
          // observed cursor exceeds the reservation, throwing here rolls back
          // the accepted mutation before any result can be broadcast.
          this.assertStorageTarget();
          this.assertReservation(reserved, beforeReads, beforeWrites);
          return value;
        };
        const tier: Tier = this.identityRow(input.userId) ? "registered" : "anonymous";
        this.chargePosting({ userId: input.userId, tier, ipKey: input.ipKey, now: effective });
        let committed: StoreMutationResult;
        if (method === "me") {
          committed = this.commitMeMutation(input, effective);
        } else {
          const state = this.logState();
          const startLogId = state.last_log_id;
          const context: CommitContext = { state, commitMs: Math.max(effective, state.last_commit_ms), touched: new Map() };
          const floor = state.history_floor;
          committed = method === "message" ? this.commitMessage(input, context, floor)
            : method === "room_set" ? this.commitRoom(input, context, floor, tier === "registered")
            : this.commitReactions(input, context, floor);
          this.finishCommit(context, startLogId);
        }
        this.commitStoredResult(input.userId, input.requestId, digest, method, committed.result, effective + this.config.dedupTtlMs);
        return beforeCommit(committed);
      });
    } finally {
      this.settleReservation(reserved, beforeReads, beforeWrites);
    }
  }

  /** Runtime adapter: commits a private copy of the request parameters. */
  mutate(input: StoreMutationInput): StoreMutationResult {
    return this.commitMutation({ ...input, params: clone(input.params) });
  }

  /** History with the per-user/IP history quota charged (§4.1). */
  history(query: StoreHistoryQuery): StoreHistoryResult {
    this.ensureReady();
    const operationNow = query.now ?? this.clock.now();
    return this.reserved({
      ...this.config.historyCost,
      reads: Math.max(256, this.config.historyCost.reads ?? 0),
      // A page writes only its two limiter rows and the budget row: about 20
      // rows for a first request, which creates both limiter rows.
      writes: Math.max(32, this.config.historyCost.writes ?? 0),
    }, false, operationNow, () => {
      const now = this.effectiveNow(operationNow);
      return this.transaction(() => {
        if (query.userId && query.ipKey) {
          this.chargeEvent("history", `user:${query.userId}`, "history", now, this.config.historyRequestsPerUserMinute, "History request limit reached");
          this.chargeEvent("history", `ip:${query.ipKey}`, "history", now, this.config.historyRequestsPerIpMinute, "History request limit reached");
        }
        return this.historyPageInternal({ ...query, now });
      });
    });
  }

  /** History without quota bookkeeping, for internal and calibration use. */
  historyPage(query: StoreHistoryQuery): StoreHistoryResult {
    this.ensureReady();
    const operationNow = query.now ?? this.clock.now();
    return this.reserved({
      ...this.config.historyCost,
      reads: Math.max(256, this.config.historyCost.reads ?? 0),
      writes: Math.max(32, this.config.historyCost.writes ?? 0),
    }, false, operationNow, () => {
      const now = this.effectiveNow(operationNow);
      return this.transaction(() => this.historyPageInternal({ ...query, now }));
    });
  }

  private historyBound(value: string | bigint | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    return numericId(typeof value === "bigint" ? numericBigInt(value, field) : value, field);
  }

  private historyPageInternal(query: StoreHistoryQuery): StoreHistoryResult {
    const roomId = query.roomId === undefined ? ROOM_ID : query.roomId;
    if (typeof roomId !== "string" || roomId.length === 0) throw new StoreError("invalid_params", "room_id must be a non-empty string");
    const room = this.roomRow(roomId);
    if (!room) throw new StoreError("invalid_params", "unknown room");
    const floor = this.logState().history_floor;
    const lowerBound = roomHistoryFloor(room, floor);
    const head = room.latest_log_id;
    const after = this.historyBound(query.after, "after");
    const before = this.historyBound(query.before, "before");
    const lower = Math.max(lowerBound, after ?? lowerBound);
    const upper = Math.min(head, before ?? head);
    const limit = positiveLimit(query.limit, this.config.historyDefaultLimit, this.config.maxHistoryLimit);
    const maxBytes = Math.min(query.maxBytes ?? this.config.maxHistoryResponseBytes, this.config.maxHistoryResponseBytes);
    const latestLogId = idString(head);
    const historyLogId = roomHistoryLogId(room, floor);
    // An empty slice has neither bound and omits every array (§4.1).
    const empty = (): StoreHistoryResult => ({ more: false, latest_log_id: latestLogId, history_log_id: historyLogId });
    const forward = after !== undefined;
    // One contiguous slice of the room's log across every record kind; the
    // limit counts records of any kind (§4.1). A window bounded to one log_id
    // (after == before) is that record in this room's log only: a moved
    // message's earlier snapshot is fetched from the room its prev_room_id names.
    const rows = lower > upper || historyLogId === null ? [] : this.rawRows<RawRecordRow>(
      `SELECT room_id, log_id, kind, record_json FROM records
       WHERE room_id = ? AND log_id >= ? AND log_id <= ?
       ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`,
      room.room_id, lower, upper, limit + 1,
    );
    if (rows.length === 0) return empty();
    // The runtime wraps this result in a JSON-RPC response.  Reserve a fixed
    // envelope allowance for jsonrpc/id/result keys, decimal IDs, commas and
    // first/last/more fields.  An empty page is always valid even when a
    // caller supplies a tiny maxBytes value, so apply this allowance only
    // while considering a non-empty entry.
    // A 128-byte request ID can require 768 JSON bytes when escaped.
    const responseOverhead = 1024;
    let bytes = utf8Bytes(JSON.stringify({
      rooms: [], messages: [], reactions: [], membership: [], first_log_id: latestLogId, last_log_id: latestLogId,
      more: false, latest_log_id: latestLogId, history_log_id: historyLogId,
    }));
    let stoppedForBytes = false;
    const selected: Array<{ logId: number; kind: string; value: Record<string, unknown> }> = [];
    for (const row of rows.slice(0, limit + 1)) {
      const value = parseJson<Record<string, unknown>>(row.record_json);
      // Room records carry this client's delivery fields, as announcements do.
      if (row.kind === "room") Object.assign(value, { latest_log_id: latestLogId, history_log_id: historyLogId });
      const entryBytes = utf8Bytes(JSON.stringify(value));
      if (entryBytes + bytes + responseOverhead + 1 > maxBytes) {
        if (selected.length === 0) throw new StoreError("too_large", "history record exceeds response budget");
        stoppedForBytes = true;
        break;
      }
      selected.push({ logId: row.log_id, kind: row.kind, value });
      bytes += entryBytes + 1;
      if (selected.length >= limit) break;
    }
    const more = stoppedForBytes || rows.length > selected.length;
    if (!forward) selected.reverse();
    if (!selected.length) return empty();
    const rooms: RoomRecord[] = [];
    const messages: MessageSnapshot[] = [];
    const reactions: ReactionsRecord[] = [];
    const membership: MembershipRecord[] = [];
    for (const record of selected) {
      if (record.kind === "room") rooms.push(record.value as unknown as RoomRecord);
      else if (record.kind === "reactions") reactions.push(record.value as unknown as ReactionsRecord);
      else if (record.kind === "membership") membership.push(record.value as unknown as MembershipRecord);
      else messages.push(record.value as unknown as MessageSnapshot);
    }
    // Records keep the user objects they were logged with; history carries no `users` (§3.3).
    return {
      ...(rooms.length ? { rooms } : {}),
      ...(messages.length ? { messages } : {}),
      ...(reactions.length ? { reactions } : {}),
      ...(membership.length ? { membership } : {}),
      first_log_id: idString(selected[0].logId),
      last_log_id: idString(selected[selected.length - 1].logId),
      more,
      latest_log_id: latestLogId,
      history_log_id: historyLogId,
    };
  }

  /** The withheld control rows can persist one deferral and its reset alarm. */
  private deferCleanup(effective: number): void {
    const nextDue = Math.max(effective + 1000, (Math.floor(effective / 86_400_000) + 1) * 86_400_000);
    if (this.deferredCleanupUntil >= nextDue) return;
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveMaintenanceControl({ reads: 2, writes: 2 }, effective);
    this.rawExec("UPDATE maintenance SET next_cleanup_ms = ? WHERE id = 1", nextDue);
    this.deferredCleanupUntil = nextDue;
    this.assertReservation(reserved, beforeReads, beforeWrites);
  }

  /**
   * Indexed existence checks, each reading at most one row, and the list of
   * removed rooms whose memberships await purge. Thread-room expiry is not
   * probed here: it can only become due when a job advances the floor, and
   * that job keeps running until its own continuation check is clear.
   */
  private cleanupHasWork(floor: number, cutoff: number, effective: number, limiterCutoff: number): boolean {
    return roomIdList(this.metaValue(META_PURGE_ROOMS)).length > 0 ||
      this.rawRows("SELECT log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT 1", floor).length > 0 ||
      this.rawRows("SELECT log_id FROM records INDEXED BY records_retention_idx WHERE commit_ms < ? ORDER BY commit_ms, log_id LIMIT 1", cutoff).length > 0 ||
      this.rawRows("SELECT message_id FROM message_state WHERE latest_log_id < ? ORDER BY latest_log_id LIMIT 1", floor).length > 0 ||
      this.rawRows("SELECT message_id FROM reaction_state WHERE log_id < ? ORDER BY log_id LIMIT 1", floor).length > 0 ||
      this.rawRows("SELECT user_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT 1", effective).length > 0 ||
      this.rawRows("SELECT scope FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT 1", limiterCutoff).length > 0;
  }

  private limiterCutoff(effective: number): number {
    // Principal authority is independent of chat retention: keep the current
    // UTC day's counters and every still-live rolling-minute event.
    return Math.min(Math.floor(effective / 86_400_000) * 86_400_000, effective - POST_WINDOW_MS);
  }

  runCleanup(now = this.clock.now()): StoreCleanupResult {
    this.ensureReady();
    // An alarm may have fired, and cleanup may establish an earlier continuation.
    this.scheduledAlarmAt = undefined;
    // A challenge deadline is not an hourly cleanup. Its cheap due check must
    // not consume the reservation for a complete deletion batch.
    let gate: { maintenance: RawMaintenanceRow; state: RawLogState; effective: number };
    try {
      gate = this.reserved({ reads: 14, writes: 2 }, true, now, () => {
        const maintenance = this.maintenanceRow();
        const state = this.logState();
        const effective = this.effectiveNow(now);
        // A non-null cursor marks a job whose last batch reported more work
        // (including expired thread rooms, which the cheap probes below do not
        // cover). Continue it rather than letting the idle check end it.
        const jobInProgress = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null;
        if (!jobInProgress && effective >= Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil)) {
          const cutoff = effective - this.config.retentionMs;
          // Idle hours must not burn a full deletion reservation.
          if (!this.cleanupHasWork(state.history_floor, cutoff, effective, this.limiterCutoff(effective))) {
            maintenance.next_cleanup_ms = effective + this.config.cleanupIntervalMs;
            this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = NULL, cleanup_cursor = NULL WHERE id = 1", maintenance.next_cleanup_ms);
          }
        }
        return { maintenance, state, effective };
      });
    } catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") this.deferCleanup(Math.max(now, this.lastEffectiveMs));
      throw error;
    }
    const { maintenance, state, effective } = gate;
    const previousFloor = state.history_floor;
    const due = Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const empty = (nextDue: number): StoreCleanupResult => ({
      history_floor: idString(previousFloor), previous_floor: idString(previousFloor), latest_id: idString(state.last_log_id),
      deleted_records: 0, deleted_messages: 0, deleted_reactions: 0, deleted_memberships: 0, deleted_requests: 0, deleted_limiters: 0,
      removed_rooms: [], next_due_ms: nextDue, did_work: false,
    });
    if (effective < due) return empty(due);
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    let reserved: BudgetCost;
    try { reserved = this.reserveCost(this.config.cleanupCost, true, effective); }
    catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") {
        this.deferCleanup(effective);
        return empty(this.deferredCleanupUntil);
      }
      throw error;
    }
    // A job's retention cutoff is fixed until all of its bounded batches finish.
    const cutoff = maintenance.cleanup_cursor !== null && maintenance.cleanup_cutoff_ms !== null
      ? maintenance.cleanup_cutoff_ms : effective - this.config.retentionMs;
    const batch = Math.min(100, this.config.cleanupBatch);
    let floor = previousFloor;
    // Commit the server-wide coverage boundary/job before physical deletion.
    // A failed deletion leaves logically expired rows hidden and an
    // idempotent job. Commit times are nondecreasing in log order, so the
    // expired set is always a prefix of the one server-wide log.
    this.transaction(() => {
      const pending = this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT 1", floor,
      );
      const expired = pending.length ? [] : this.rawRows<{ log_id: number }>(
        `SELECT log_id FROM records INDEXED BY records_retention_idx
         WHERE commit_ms < ? AND log_id >= ?
         ORDER BY commit_ms, log_id LIMIT ?`, cutoff, floor, batch,
      );
      if (expired.length) floor = Math.max(floor, expired[expired.length - 1].log_id + 1);
      this.rawExec("UPDATE log_state SET history_floor = ? WHERE id = 1", floor);
      this.rawExec("UPDATE maintenance SET cleanup_cutoff_ms = ?, cleanup_cursor = ?, next_cleanup_ms = ? WHERE id = 1", cutoff, floor, effective + 1000);
      this.assertReservation(reserved, beforeReads, beforeWrites);
    });
    const result = this.transaction(() => {
      let remaining = batch;
      const records = this.rawRows<{ room_id: string; log_id: number }>(
        "SELECT room_id, log_id FROM records INDEXED BY records_log_idx WHERE log_id < ? ORDER BY log_id LIMIT ?", floor, remaining,
      );
      for (const row of records) this.rawExec("DELETE FROM records WHERE room_id = ? AND log_id = ?", row.room_id, row.log_id);
      remaining -= records.length;
      // Current state survives while its latest record is retained.
      const messages = remaining > 0 ? this.rawRows<{ message_id: string }>(
        "SELECT message_id FROM message_state WHERE latest_log_id < ? ORDER BY latest_log_id LIMIT ?", floor, remaining,
      ) : [];
      for (const row of messages) this.rawExec("DELETE FROM message_state WHERE message_id = ? AND latest_log_id < ?", row.message_id, floor);
      remaining -= messages.length;
      const reactions = remaining > 0 ? this.rawRows<{ message_id: string; user_id: string }>(
        "SELECT message_id, user_id FROM reaction_state WHERE log_id < ? ORDER BY log_id LIMIT ?", floor, remaining,
      ) : [];
      for (const row of reactions) this.rawExec("DELETE FROM reaction_state WHERE message_id = ? AND user_id = ? AND log_id < ?", row.message_id, row.user_id, floor);
      remaining -= reactions.length;
      // A thread room whose entire log (creation record included) has been
      // discarded leaves the visible set. No message, reaction, or membership
      // can still be current in it: each touches the room's head when
      // committed. The rooms table is capped at the calibrated thread ceiling,
      // bounding this scan. Its registered members' rows are purged below, in
      // batches; until then the join with `rooms` hides them.
      let purge = roomIdList(this.metaValue(META_PURGE_ROOMS));
      const rooms = remaining > 0 && purge.length < MAX_PURGE_ROOMS ? this.rawRows<{ room_id: string }>(
        "SELECT room_id FROM rooms WHERE parent_room_id IS NOT NULL AND latest_log_id < ? ORDER BY created_log_id LIMIT ?", floor, Math.min(remaining, MAX_PURGE_ROOMS - purge.length),
      ) : [];
      for (const row of rooms) this.rawExec("DELETE FROM rooms WHERE room_id = ? AND parent_room_id IS NOT NULL AND latest_log_id < ?", row.room_id, floor);
      if (rooms.length) this.rawExec("UPDATE _meta SET value = ? WHERE key = 'thread_count'", String(Math.max(0, this.metaNumber("thread_count") - rooms.length)));
      remaining -= rooms.length;
      const purgeBefore = purge.length;
      purge = [...purge, ...rooms.map((row) => row.room_id)];
      let memberships = 0;
      while (purge.length && remaining > 0) {
        const roomId = purge[0];
        const members = this.rawRows<{ user_id: string }>("SELECT user_id FROM memberships WHERE room_id = ? LIMIT ?", roomId, remaining + 1);
        const batchRows = members.slice(0, remaining);
        for (const row of batchRows) this.rawExec("DELETE FROM memberships WHERE room_id = ? AND user_id = ?", roomId, row.user_id);
        memberships += batchRows.length;
        remaining -= batchRows.length;
        if (members.length > batchRows.length) break;
        purge.shift();
      }
      if (rooms.length || purge.length !== purgeBefore) {
        this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_PURGE_ROOMS, JSON.stringify(purge));
      }
      const requests = remaining > 0 ? this.rawRows<{ user_id: string; request_id: string }>(
        "SELECT user_id, request_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT ?", effective, remaining,
      ) : [];
      for (const row of requests) this.rawExec("DELETE FROM accepted_requests WHERE user_id = ? AND request_id = ?", row.user_id, row.request_id);
      remaining -= requests.length;
      const limiterCutoff = this.limiterCutoff(effective);
      const limiters = remaining > 0 ? this.rawRows<{ scope: string; principal_key: string }>(
        "SELECT scope, principal_key FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT ?", limiterCutoff, remaining,
      ) : [];
      for (const row of limiters) this.rawExec("DELETE FROM principal_limits WHERE scope = ? AND principal_key = ?", row.scope, row.principal_key);
      if (limiters.length) this.rawExec("UPDATE _meta SET value = ? WHERE key = 'principal_limit_count'", String(Math.max(0, this.metaNumber("principal_limit_count") - limiters.length)));
      const hasMore = this.cleanupHasWork(floor, cutoff, effective, limiterCutoff) ||
        this.rawRows("SELECT room_id FROM rooms WHERE parent_room_id IS NOT NULL AND latest_log_id < ? LIMIT 1", floor).length > 0;
      const nextDue = effective + (hasMore ? 1000 : this.config.cleanupIntervalMs);
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = ?, cleanup_cursor = ? WHERE id = 1", nextDue, hasMore ? cutoff : null, hasMore ? floor : null);
      this.assertReservation(reserved, beforeReads, beforeWrites);
      const deleted = records.length + messages.length + reactions.length + rooms.length + memberships + requests.length + limiters.length;
      return {
        history_floor: idString(floor), previous_floor: idString(previousFloor), latest_id: idString(state.last_log_id),
        deleted_records: records.length, deleted_messages: messages.length, deleted_reactions: reactions.length,
        deleted_memberships: memberships, deleted_requests: requests.length, deleted_limiters: limiters.length,
        removed_rooms: rooms.map((row) => row.room_id),
        next_due_ms: nextDue,
        did_work: floor !== previousFloor || deleted > 0,
      };
    });
    // Refunded after the transaction commits, so a rollback cannot leave a credit behind.
    this.refundUnused(reserved, this.observed.reads - beforeReads, this.observed.writes - beforeWrites);
    return result;
  }

  cleanup(now: number): DomainCleanupResult {
    const result = this.runCleanup(now);
    return {
      changed: result.did_work,
      nextAt: result.next_due_ms,
    };
  }

  /**
   * Schedule the earliest active socket deadline and persisted cleanup task.
   * Socket deadlines live in bounded hibernation attachments, so this method
   * deliberately does not create one durable row per connection.
   */
  async scheduleAlarm(socketDeadline?: number, now = this.clock.now()): Promise<void> {
    this.ensureReady();
    const candidateTime = Math.max(Math.trunc(now), this.lastEffectiveMs);
    if (this.scheduledAlarmAt !== undefined && this.scheduledAlarmAt > candidateTime &&
        (socketDeadline === undefined || this.scheduledAlarmAt <= socketDeadline)) return;
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    let reserved: BudgetCost;
    try { reserved = this.reserveCost({ reads: 16, writes: 4 }, true, now); }
    catch (error) {
      if (!(error instanceof StoreError) || error.code !== "retry_after") throw error;
      // Two of the eight withheld control rows defer cleanup; six remain to
      // install its reset alarm even after ordinary maintenance is exhausted.
      reserved = this.reserveMaintenanceControl({ reads: 6, writes: 6 }, now);
    }
    const effective = Math.max(Math.trunc(now), this.lastEffectiveMs);
    const maintenance = this.maintenanceRow();
    const cleanupDue = Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const dueAt = Math.max(effective, socketDeadline === undefined ? cleanupDue : Math.min(cleanupDue, socketDeadline));
    const getAlarm = this.durableStorage?.getAlarm;
    const setAlarm = this.durableStorage?.setAlarm;
    if (typeof getAlarm !== "function" || typeof setAlarm !== "function") throw new StoreError("internal_error", "Alarm storage unavailable");
    // Capture this call's SQL before awaiting: another socket can complete
    // cryptography meanwhile. Its separately metered SQL must not be counted
    // again against this alarm's reservation.
    let actualReads = this.observed.reads - beforeReads;
    let actualWrites = this.observed.writes - beforeWrites;
    try {
      // Native alarm methods expose no cursor. Reserve conservative hidden
      // control-row costs even when the native call fails.
      actualReads += 2; this.observed.reads += 2;
      const existing = await getAlarm.call(this.durableStorage);
      if (existing !== null && Number.isFinite(existing) && existing > effective && existing <= dueAt) {
        this.scheduledAlarmAt = existing;
        return;
      }
      actualReads += 2; actualWrites += 2;
      this.observed.reads += 2; this.observed.writes += 2;
      await setAlarm.call(this.durableStorage, dueAt);
      this.scheduledAlarmAt = dueAt;
    } finally {
      this.settleReservation(reserved, this.observed.reads - actualReads, this.observed.writes - actualWrites);
    }
  }
}
