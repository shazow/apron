/*
 * Durable storage for the public Apron demo.
 *
 * The worker deliberately keeps all authoritative state behind this module.  A
 * Durable Object is single threaded, but requests can still be interleaved at
 * every await in the websocket handler.  Store methods are synchronous with
 * respect to SQLite; callers can therefore make the reply/broadcast gate wait
 * for a complete mutation before exposing its result.
 */

import { BOOTSTRAP_ROW_RESERVATION, DEFAULT_LIMITS, MAINTENANCE_CONTROL_RESERVE } from "./budget";
import type { AccountUsageSnapshot } from "./account-usage";
import type {
  AdmissionSnapshot,
  AuthTier,
  CleanupResult as DomainCleanupResult,
  DedupRecord,
  HistoryEntry as DomainHistoryEntry,
  HistoryPage,
  HistoryQuery as DomainHistoryQuery,
  Identity as DomainIdentity,
  MutationCommit,
  MutationInput as DomainMutationInput,
  RoomState as DomainRoomState,
  StoredCredential,
  StoredIdentity,
  ThreadRecord as DomainThreadRecord,
} from "./domain.js";
// @ts-expect-error Workers' nodejs_compat runtime supplies this module; the
// worker type package intentionally omits Node's full module declarations.
import { createHash } from "node:crypto";

export const ROOM_ID = "general";
export const SCHEMA_VERSION = 1;
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
  readonly retryAfterMs?: number;
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
  maxThreads: number;
  maxThreadMetadataBytes: number;
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

export interface StoreThreadRecord {
  room_id: string;
  thread_id: string;
  title?: string;
  summary?: string;
  root_message_id?: string;
  created_at?: number;
  updated_at?: number;
  [key: string]: unknown;
}

export interface MessageSnapshot {
  message_id: string;
  from: Identity;
  body?: Record<string, unknown>;
  reply_message_id?: string;
  thread_id?: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface Transition {
  room_id: string;
  log_id: string;
  commit_ms: number;
  message_id: string;
  message: MessageSnapshot;
  previous_thread_id?: string;
  thread_id?: string;
}

export interface StoreRoomState {
  room_id: string;
  latest_log_id: string;
  history_log_id: string | null;
  last_commit_ms: number;
  name: string;
  topic?: string;
}

export interface StoreMutationInput {
  userId: string;
  tier?: Tier;
  ipKey: string;
  requestId?: string;
  method?: "message" | "thread" | string;
  roomId?: string;
  now?: number;
  /** Pre-parsed protocol parameters, when the runtime already validated them. */
  params: Record<string, unknown>;
  identity: Identity;
  digest?: string;
  /** Existing message ID selects replacement; absent creates a message. */
  messageId?: string;
  /** Complete client editable message fields. Server-owned fields are ignored. */
  message?: Record<string, unknown>;
  body?: Record<string, unknown>;
  threadId?: string;
  replyMessageId?: string;
  deleted?: boolean;
  /** Set for a thread creation/edit operation. */
  thread?: {
    threadId?: string;
    title?: string;
    summary?: string;
    rootMessageId?: string;
  };
}

export interface StoreMutationResult {
  result: Record<string, unknown>;
  transition?: Transition;
  thread?: StoreThreadRecord;
  deduplicated?: boolean;
}

export interface StoreHistoryQuery {
  roomId?: string;
  after?: string;
  before?: string;
  limit?: number;
  threadId?: string;
  now?: number;
  /** Request identity for history quota accounting. */
  userId?: string;
  ipKey?: string;
  maxBytes?: number;
}

export interface StoreHistoryEntry {
  log_id: string;
  message: MessageSnapshot;
}

export interface StoreHistoryResult {
  entries: StoreHistoryEntry[];
  first_id?: string;
  last_id?: string;
  more: boolean;
  latest_log_id: string;
  history_log_id: string | null;
}

export interface StoreCleanupResult {
  history_floor: string;
  latest_id: string;
  deleted_transitions: number;
  deleted_messages: number;
  deleted_requests: number;
  deleted_limiters: number;
  next_due_ms: number;
  did_work: boolean;
}

/** Legacy/domain adapter input used by the websocket runtime. */
export type MutationInput = StoreMutationInput;

export interface BudgetCost {
  reads: number;
  writes: number;
  frames: number;
  admissions: number;
  posts: number;
  registrations: number;
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

interface RawRoomRow {
  room_id: string;
  last_log_id: number;
  history_floor: number;
  last_commit_ms: number;
  metadata_json: string;
}

interface RawTransitionRow {
  room_id: string;
  log_id: number;
  commit_ms: number;
  message_id: string;
  snapshot_json: string;
  previous_thread_id: string | null;
  thread_id: string | null;
}

interface RawMessageRow {
  room_id: string;
  message_id: string;
  latest_log_id: number;
  latest_commit_ms: number;
  snapshot_json: string;
  author_id: string;
  thread_id: string | null;
}

interface RawThreadRow {
  room_id: string;
  thread_id: string;
  title: string | null;
  summary: string | null;
  root_message_id: string | null;
  created_ms: number;
  updated_ms: number;
}

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
const META_NEXT_THREAD = "next_thread_seq";
const META_ACCOUNTING_UNSAFE = "accounting_unsafe";
const META_ACCOUNT_USAGE = "account_usage_snapshot";

function isFiniteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

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
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;
  // Workers and current Node always provide TextEncoder.  This fallback keeps
  // small pure-logic tests usable in older JS runtimes.
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function historyLogId(head: number, floor: number): string | null {
  return floor <= head ? idString(floor) : null;
}

function ensureText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string") throw new StoreError("invalid_params", `${field} must be a string`);
  if (utf8Bytes(value) > maxBytes) throw new StoreError("too_large", `${field} is too large`);
  return value;
}

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
  private budgetHandoverPending = false;
  /** UTC day for which this object has already attempted bounded row pruning. */
  private budgetPruneDay: string | null = null;
  private accountingUnsafe = false;
  private accountingUnsafePersisted = false;
  private accountingUnsafePending = false;
  private deferredCleanupUntil = 0;

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
    if (version > SCHEMA_VERSION) throw new Error(`unsupported storage schema ${version}`);
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
    try {
      this.transaction(() => {
      this.rawScript(`
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
      `);
      const now = this.effectiveNow(this.clock.now());
      this.rawExec(
        "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?), ('effective_now_ms', ?), ('next_thread_seq', '0'), ('identity_count', '0'), ('thread_count', '0'), ('principal_limit_count', '0'), ('budget_stop_day', ''), ('accounting_unsafe', '0')",
        String(SCHEMA_VERSION),
        String(now),
      );
      this.rawExec(
        "INSERT OR REPLACE INTO maintenance (id, next_cleanup_ms, cleanup_cutoff_ms, cleanup_cursor, schema_version) VALUES (1, ?, NULL, NULL, ?)",
        now + this.config.cleanupIntervalMs,
        SCHEMA_VERSION,
      );
      this.ensureRoomRow();
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
      });
    } catch (error) {
      throw error;
    }
    this.budgetCacheDay = null;
    this.budgetCache = null;
    this.budgetHandoverPending = true;
    this.budgetPruneDay = dayFor(Math.max(this.lastEffectiveMs, this.clock.now()));
    this.initialized = true;
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

  private ensureRoomRow(): void {
    this.rawExec(
      "INSERT OR IGNORE INTO room_state (room_id, last_log_id, history_floor, last_commit_ms, metadata_json) VALUES (?, 0, 1, 0, ?)",
      ROOM_ID,
      JSON.stringify({ name: "General" }),
    );
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
    if (pruning) {
      cost.reads += BUDGET_PRUNE_RESERVATION_READS;
      cost.writes += BUDGET_PRUNE_RESERVATION_WRITES;
    }
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
      throw new StoreError("retry_after", maintenance ? "Maintenance budget exhausted" : "Demo capacity reached", {
        retryAfterMs: next,
        data: { ms: next },
      });
    }
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
    return cost;
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
      this.assertReservation(reserved, beforeReads, beforeWrites);
    }
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

  private reserved<T>(cost: CostEstimate, maintenance: boolean, now: number, fn: () => T): T {
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost(cost, maintenance, now);
    try {
      return fn();
    } finally {
      this.assertReservation(reservation, beforeReads, beforeWrites);
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
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs, data: { ms: this.config.cleanupIntervalMs } });
    }
    if (paused) {
      if (size > this.config.storageLowWaterBytes) throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs, data: { ms: this.config.cleanupIntervalMs } });
      this.rawExec("UPDATE _meta SET value = '0' WHERE key = 'storage_pressure'");
    }
  }

  private assertStorageTarget(): void {
    const size = this.databaseSize();
    if (size === null || size > this.config.storageHardTargetBytes) {
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: this.config.cleanupIntervalMs, data: { ms: this.config.cleanupIntervalMs } });
    }
  }

  private roomRow(): RawRoomRow {
    this.ensureReady();
    const rows = this.rawRows<RawRoomRow>(
      "SELECT room_id, last_log_id, history_floor, last_commit_ms, metadata_json FROM room_state WHERE room_id = ? LIMIT 1",
      ROOM_ID,
    );
    if (!rows.length) throw new StoreError("internal_error", "general room state is missing");
    return rows[0];
  }

  /** Runtime-facing room metadata. IDs stay bigint inside the domain boundary. */
  room(): DomainRoomState {
    this.ensureReady();
    return this.reserved({ reads: 256 }, false, this.clock.now(), () => {
      const row = this.roomRow();
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, { name: "General" });
      void metadata;
      return {
        roomId: ROOM_ID,
        latestId: BigInt(row.last_log_id),
        historyFloor: BigInt(row.history_floor),
        threads: this.threadRecords(),
      };
    });
  }

  getRoomState(): StoreRoomState {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => {
      const row = this.roomRow();
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, { name: "General" });
      return {
        room_id: ROOM_ID,
        latest_log_id: idString(row.last_log_id),
        history_log_id: historyLogId(row.last_log_id, row.history_floor),
        last_commit_ms: row.last_commit_ms,
        name: typeof metadata.name === "string" ? metadata.name : "General",
        topic: typeof metadata.topic === "string" ? metadata.topic : undefined,
      };
    });
  }

  private threadRecords(): DomainThreadRecord[] {
    const rows = this.rawRows<RawThreadRow>(
      "SELECT thread_id, title, summary FROM threads WHERE room_id = ? ORDER BY thread_id ASC",
      ROOM_ID,
    );
    return rows.map((row) => ({
      threadId: row.thread_id,
      ...(row.title !== null ? { title: row.title } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
    }));
  }

  getThreads(): StoreThreadRecord[] {
    this.ensureReady();
    return this.reserved({ reads: 256 }, false, this.clock.now(), () => {
      const rows = this.rawRows<RawThreadRow>(
        "SELECT room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms FROM threads WHERE room_id = ? ORDER BY thread_id ASC LIMIT ?",
        ROOM_ID,
        this.config.maxThreads,
      );
      return rows.map((row) => ({
        room_id: row.room_id,
        thread_id: row.thread_id,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.summary !== null ? { summary: row.summary } : {}),
        ...(row.root_message_id !== null ? { root_message_id: row.root_message_id } : {}),
        created_at: row.created_ms,
        updated_at: row.updated_ms,
      }));
    });
  }

  private threadRow(threadId: string): RawThreadRow | null {
    const rows = this.rawRows<RawThreadRow>(
      "SELECT room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms FROM threads WHERE room_id = ? AND thread_id = ? LIMIT 1",
      ROOM_ID,
      threadId,
    );
    return rows[0] ?? null;
  }

  getThread(threadId: string): StoreThreadRecord | null {
    this.ensureReady();
    return this.reserved({ reads: 8 }, false, this.clock.now(), () => {
      const row = this.threadRow(threadId);
      return row ? {
        room_id: row.room_id,
        thread_id: row.thread_id,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.summary !== null ? { summary: row.summary } : {}),
        ...(row.root_message_id !== null ? { root_message_id: row.root_message_id } : {}),
        created_at: row.created_ms,
        updated_at: row.updated_ms,
      } : null;
    });
  }

  private identityRow(userId: string): RawIdentityRow | null {
    const rows = this.rawRows<RawIdentityRow>(
      "SELECT user_id, user_handle, name, tier, created_ms, updated_ms FROM identities WHERE user_id = ? LIMIT 1",
      userId,
    );
    return rows[0] ?? null;
  }

  getIdentity(userId: string): StoredIdentity | null {
    this.ensureReady();
    return this.reserved({ reads: 16 }, false, this.clock.now(), () => {
      const row = this.identityRow(userId);
      if (!row) return null;
      const count = this.rawRows<{ count: number }>("SELECT COUNT(*) AS count FROM credentials WHERE user_id = ? LIMIT 1", userId)[0];
      const credentialCount = integerColumn(count?.count);
      return {
        userId: row.user_id,
        name: row.name,
        userHandle: row.user_handle,
        credentialCount,
      };
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
      throw new StoreError("retry_after", "Demo capacity reached", { retryAfterMs: 60_000, data: { ms: 60_000 } });
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
      throw new StoreError("retry_after", message, { retryAfterMs: retry, data: { ms: retry } });
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
          reason = index === 0 && tier === "anonymous" ? "Anonymous posting limit reached" : "Posting limit reached";
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
    if (retryAfterMs > 0) throw new StoreError("retry_after", reason, { retryAfterMs, data: { ms: retryAfterMs } });
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
          throw new StoreError("retry_after", "Frame rate limit reached", { retryAfterMs: retry, data: { ms: retry } });
        }
        // Reuse auth_events_json as a bounded generic frame-event lane; the
        // scope separates it from authentication rows.
        this.updateLimitRow(row, { auth_events_json: JSON.stringify([...events, ...Array.from({ length: count }, () => effective)]) }, effective);
        const global = this.limitRow("frames", "global", effective);
        const day = dayFor(effective);
        const globalCount = global.day === day ? global.posts_day : 0;
        if (globalCount + count > this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000, data: { ms: 86_400_000 } });
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
      throw new StoreError("retry_after", "Registration limit reached for this network", { retryAfterMs, data: { ms: retryAfterMs } });
    }
    if (globalCount >= this.config.registrationsPerDay) {
      throw new StoreError("retry_after", "Registration limit reached", { retryAfterMs, data: { ms: retryAfterMs } });
    }
    this.updateLimitRow(ip, { day, registrations_day: ipCount + 1 }, now);
    this.updateLimitRow(global, { day, registrations_day: globalCount + 1 }, now);
  }

  registerIdentity(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
  }): StoredIdentity {
    this.ensureReady();
    const { credential } = input;
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reservation = this.reserveCost({ reads: 128, writes: 64, registrations: 1 }, false, input.now);
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
        return beforeCommit({
          userId: input.userId,
          name: input.name,
          userHandle: input.userHandle,
          credentialCount: 1,
        });
      });
    } finally {
      this.assertReservation(reservation, beforeReads, beforeWrites);
    }
  }

  registerCredential(input: {
    userId: string;
    name: string;
    userHandle: string;
    credential: StoredCredential;
    now: number;
    ipKey: string;
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
        if (admissions >= this.config.connectionAdmissionsPerDay) throw new StoreError("retry_after", "Connection admission limit reached", { retryAfterMs: 86_400_000, data: { ms: 86_400_000 } });
        this.updateLimitRow(global, { day, posts_day: admissions + 1 }, now);
        // Live connection caps are authoritative in ctx.getWebSockets(), which
        // includes closing sockets and survives object hibernation.  Durable
        // open counters become stale after a lost close and can permanently
        // deny admission, so only the durable admission/day and frame budget
        // controls are maintained here.
        const frames = this.limitRow("frames", "global", now);
        const frameCount = frames.day === day ? frames.posts_day : 0;
        if (frameCount >= this.config.processedFramesPerDay) {
          throw new StoreError("retry_after", "Daily frame budget exhausted", { retryAfterMs: 86_400_000, data: { ms: 86_400_000 } });
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
        // Kept for the legacy inspection API; callers must use
        // getWebSockets() for the live value.
        openConnections: 0,
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
      `SELECT room_id, message_id, latest_log_id, latest_commit_ms, snapshot_json, author_id, thread_id
       FROM messages WHERE room_id = ? AND message_id = ? LIMIT 1`,
      ROOM_ID,
      messageId,
    );
    if (!rows.length) return null;
    if (floor !== undefined && rows[0].latest_log_id < floor) return null;
    return rows[0];
  }

  private identityForMessage(input: DomainMutationInput): Identity {
    const name = typeof input.identity.name === "string" ? input.identity.name : undefined;
    return { user_id: input.identity.user_id, ...(name ? { name } : {}) };
  }

  private normalizedBody(value: unknown): Record<string, unknown> {
    const body = jsonObject(value, "body");
    const text = body.text === undefined ? "" : ensureText(body.text, "body.text", this.config.maxTextBytes);
    const format = body.format === undefined ? "markdown" : body.format;
    if (format !== "plain" && format !== "markdown") throw new StoreError("invalid_params", "body.format is invalid");
    const embeds = body.embeds === undefined ? [] : body.embeds;
    if (!Array.isArray(embeds)) throw new StoreError("invalid_params", "body.embeds must be an array");
    if (embeds.length > this.config.maxEmbeds) throw new StoreError("too_large", "too many embeds");
    return { ...clone(body), text, format, embeds: clone(embeds) };
  }

  private validateSnapshot(snapshot: MessageSnapshot): void {
    const serialized = JSON.stringify(snapshot);
    if (utf8Bytes(serialized) > this.config.maxSnapshotBytes) throw new StoreError("too_large", "message snapshot is too large");
    if (snapshot.deleted === true) {
      delete snapshot.body;
    } else if (!snapshot.body) {
      throw new StoreError("invalid_params", "message body is required");
    }
    if (snapshot.reply_message_id !== undefined) ensureText(snapshot.reply_message_id, "reply_message_id", 256);
    if (snapshot.thread_id !== undefined) ensureText(snapshot.thread_id, "thread_id", 256);
  }

  private messageFromParams(input: DomainMutationInput, current: RawMessageRow | null, messageId: string, historyFloor?: number): MessageSnapshot {
    const params = input.params;
    const suppliedMessageId = params.message_id;
    if (suppliedMessageId !== undefined && typeof suppliedMessageId !== "string") throw new StoreError("invalid_params", "message_id must be a string");
    if (params.log_id !== undefined) throw new StoreError("invalid_params", "log_id is server assigned");
    const replacing = current !== null;
    if (replacing && current && current.author_id !== input.userId) throw new StoreError("denied", "Only the original author may edit this message");
    const deleted = params.deleted === undefined ? false : params.deleted;
    if (typeof deleted !== "boolean") throw new StoreError("invalid_params", "deleted must be boolean");
    if (!replacing && deleted) throw new StoreError("invalid_params", "deleted messages must be created through an existing message");

    const threadValue = params.thread_id;
    if (threadValue !== undefined && typeof threadValue !== "string") throw new StoreError("invalid_params", "thread_id must be a string");
    if (typeof threadValue === "string" && !this.threadRow(threadValue)) throw new StoreError("invalid_params", "unknown thread");
    const replyValue = params.reply_message_id;
    if (replyValue !== undefined && typeof replyValue !== "string") throw new StoreError("invalid_params", "reply_message_id must be a string");
    if (typeof replyValue === "string") {
      if (replyValue === messageId) throw new StoreError("invalid_params", "a message cannot reply to itself");
      if (!this.currentMessage(replyValue, historyFloor)) throw new StoreError("invalid_params", "unknown or expired reply target");
    }

    let body: Record<string, unknown> | undefined;
    if (!deleted) {
      body = this.normalizedBody(params.body);
      const embeds = body.embeds as unknown[];
      if (body.text === "" && embeds.length === 0) throw new StoreError("invalid_params", "message cannot be empty");
    }
    const from = replacing && current ? parseJson<MessageSnapshot>(current.snapshot_json).from : this.identityForMessage(input);
    if (!from || typeof from.user_id !== "string") throw new StoreError("internal_error", "message author is missing");
    const snapshot: MessageSnapshot = {
      message_id: messageId,
      from: clone(from),
    };
    // All fields beside routing/server-owned fields are editable extension
    // fields. This preserves extensions without allowing clients to spoof ID
    // or author fields.
    for (const [key, value] of Object.entries(params)) {
      if (["room_id", "message_id", "log_id", "body", "from", "echo", "thread_id", "reply_message_id", "deleted"].includes(key)) continue;
      Object.defineProperty(snapshot, key, { value: clone(value), enumerable: true, configurable: true, writable: true });
    }
    if (body) snapshot.body = body;
    if (typeof threadValue === "string") snapshot.thread_id = threadValue;
    if (typeof replyValue === "string") snapshot.reply_message_id = replyValue;
    if (deleted) snapshot.deleted = true;
    this.validateSnapshot(snapshot);
    return snapshot;
  }

  private commitStoredResult(
    userId: string,
    requestId: string | undefined,
    digest: string,
    method: string,
    result: Record<string, unknown>,
    transition: Transition | undefined,
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
      // The original result is sufficient for a retry response.  Keeping a
      // full transition snapshot in every dedup row duplicates up to the
      // message payload and needlessly grows retained control data.
      null,
      expiresAt,
      expiresAt,
    );
  }

  private deduplicatedCommit(row: RawDedupRow, method: string, digest: string): MutationCommit {
    if (row.digest !== digest) throw new StoreError("invalid_params", "request ID was already used for a different operation");
    const stored = parseJson<Record<string, unknown>>(row.result_json, {});
    if (stored.__method !== undefined && stored.__method !== method) throw new StoreError("invalid_params", "request ID was already used for a different method");
    delete stored.__method;
    const transition = row.transition_json ? parseJson<Transition>(row.transition_json) : undefined;
    return {
      ...(typeof stored.message_id === "string" ? { messageId: stored.message_id } : {}),
      ...(transition ? { logId: transition.log_id, message: transition.message } : {}),
      result: stored,
      deduplicated: true,
      ...(transition ? { transition: clone(transition) } : {}),
    };
  }

  commitMutation(input: DomainMutationInput): MutationCommit;
  commitMutation(input: StoreMutationInput): StoreMutationResult;
  commitMutation(input: DomainMutationInput | StoreMutationInput): MutationCommit | StoreMutationResult {
    // The runtime's typed adapter includes params/identity; preserve those
    // fields and use the domain implementation directly. Older callers use
    // the normalized StoreMutationInput and are routed through mutate().
    if (!("params" in input) || input.params === undefined) return this.mutate(input as StoreMutationInput);
    return this.commitMutationDomain(input as DomainMutationInput);
  }

  private commitMutationDomain(input: DomainMutationInput): MutationCommit & { transition?: Transition } {
    this.ensureReady();
    if (input.params.room_id !== undefined && input.params.room_id !== ROOM_ID) throw new StoreError("invalid_params", "unknown room");
    if (!input.userId || !input.ipKey) throw new StoreError("denied", "authentication required");
    if (input.requestId !== undefined) {
      if (typeof input.requestId !== "string" || utf8Bytes(input.requestId) > 128) throw new StoreError("invalid_params", "invalid request ID");
    }
    const method = input.method ?? "message";
    const extra = input as DomainMutationInput & { digest?: string };
    const digest = extra.digest ?? digestOperation(method, input.params);
    const operationNow = input.now ?? this.clock.now();
    // A retry lookup is deliberately cheaper than a full mutation reserve.
    // Accepted retries must remain available even when posting/storage
    // capacity is exhausted, while still paying their bounded SQL lookup.
    let effective = operationNow;
    let preDuplicate: RawDedupRow | null = null;
    if (input.requestId !== undefined) {
      const lookup = this.reserved({ reads: 8, writes: 8 }, false, operationNow, () => {
        const lookupNow = this.effectiveNow(operationNow);
        return {
          now: lookupNow,
          row: this.dedupRow(input.userId, input.requestId!, lookupNow),
        };
      });
      effective = lookup.now;
      preDuplicate = lookup.row;
      if (preDuplicate) return this.deduplicatedCommit(preDuplicate, method, digest);
    }
    const mutationCost = {
      ...this.config.mutationCost,
      // The default is a conservative floor for the three posting limiter
      // rows, dedup row, transition, current snapshot, and room bookkeeping.
      reads: Math.max(256, this.config.mutationCost.reads ?? 0),
      writes: Math.max(256, this.config.mutationCost.writes ?? 0),
    };
    const beforeReads = this.observed.reads;
    const beforeWrites = this.observed.writes;
    const reserved = this.reserveCost(mutationCost, false, operationNow);
    try {
      effective = this.effectiveNow(operationNow);
      const row = this.roomRow();
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
      const duplicate = preDuplicate;
      if (duplicate) return beforeCommit(this.deduplicatedCommit(duplicate, method, digest));
      const tier: Tier = this.identityRow(input.userId) ? "registered" : "anonymous";
      this.chargePosting({ userId: input.userId, tier, ipKey: input.ipKey, now: effective });
      if (method === "thread") return beforeCommit(this.commitThreadMutation(input, digest, effective, row.history_floor));
      if (method === "nick") return beforeCommit(this.commitNickMutation(input, digest, effective));
      if (method !== "message") throw new StoreError("unsupported", "Unsupported mutation");
      const messageIdParam = input.params.message_id;
      const messageId = messageIdParam === undefined ? undefined : ensureText(messageIdParam, "message_id", 256);
      const current = messageId ? this.currentMessage(messageId, row.history_floor) : null;
      if (messageId && !current) throw new StoreError("invalid_params", "unknown or expired message");
      const allocated: string = messageId ?? idString(this.allocateLogId(row, effective));
      const snapshot = this.messageFromParams(input, current, allocated, row.history_floor);
      const previousThread = current ? optionalString(parseJson<MessageSnapshot>(current.snapshot_json).thread_id) : undefined;
      const nextThread = optionalString(snapshot.thread_id);
      const commitMs = Math.max(effective, row.last_commit_ms);
      const logIdNumber = messageId ? this.allocateLogId(row, commitMs) : numericId(allocated);
      const logId = idString(logIdNumber);
      const transition: Transition = {
        room_id: ROOM_ID,
        log_id: logId,
        commit_ms: commitMs,
        message_id: allocated,
        message: clone(snapshot),
        ...(previousThread ? { previous_thread_id: previousThread } : {}),
        ...(nextThread ? { thread_id: nextThread } : {}),
      };
      const snapshotJson = JSON.stringify(snapshot);
      this.rawExec(
        `INSERT INTO transitions
         (room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ROOM_ID,
        logIdNumber,
        commitMs,
        allocated,
        snapshotJson,
        previousThread ?? null,
        nextThread ?? null,
      );
      this.rawExec(
        `INSERT INTO messages
         (room_id, message_id, latest_log_id, latest_commit_ms, snapshot_json, author_id, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, message_id) DO UPDATE SET
           latest_log_id = excluded.latest_log_id,
           latest_commit_ms = excluded.latest_commit_ms,
           snapshot_json = excluded.snapshot_json,
           author_id = excluded.author_id,
           thread_id = excluded.thread_id`,
        ROOM_ID,
        allocated,
        logIdNumber,
        commitMs,
        snapshotJson,
        snapshot.from.user_id,
        nextThread ?? null,
      );
      this.rawExec(
        "UPDATE room_state SET last_log_id = ?, last_commit_ms = ? WHERE room_id = ?",
        Math.max(row.last_log_id, logIdNumber),
        commitMs,
        ROOM_ID,
      );
      const result = { message_id: allocated };
      this.commitStoredResult(input.userId, input.requestId, digest, method, result, transition, effective + this.config.dedupTtlMs);
      return beforeCommit({
        messageId: allocated,
        logId,
        message: clone(snapshot),
        result,
        transition: clone(transition),
      });
      });
    } finally {
      this.assertReservation(reserved, beforeReads, beforeWrites);
    }
  }

  private allocateLogId(room: RawRoomRow, now: number): number {
    const candidate = Math.max(Math.trunc(now), room.last_log_id + 1, room.history_floor);
    if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_SAFE_ID) throw new StoreError("internal_error", "log identifier range exhausted");
    return candidate;
  }

  private nextThreadId(): string {
    const next = this.metaNumber(META_NEXT_THREAD) + 1;
    this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)", META_NEXT_THREAD, String(next));
    return `t_${next.toString(36)}`;
  }

  private threadMetadata(input: DomainMutationInput, threadId: string, now: number, current?: RawThreadRow | null): StoreThreadRecord {
    const params = input.params;
    const titleValue = params.title;
    const summaryValue = params.summary;
    if (titleValue !== undefined && typeof titleValue !== "string") throw new StoreError("invalid_params", "thread title must be a string");
    if (summaryValue !== undefined && typeof summaryValue !== "string") throw new StoreError("invalid_params", "thread summary must be a string");
    const title = titleValue === undefined ? current?.title ?? undefined : titleValue === "" ? undefined : titleValue;
    const summary = summaryValue === undefined ? current?.summary ?? undefined : summaryValue === "" ? undefined : summaryValue;
    if (title && utf8Bytes(title) > this.config.maxThreadMetadataBytes) throw new StoreError("too_large", "thread title is too large");
    if (summary && utf8Bytes(summary) > this.config.maxThreadMetadataBytes) throw new StoreError("too_large", "thread summary is too large");
    const record: StoreThreadRecord = {
      room_id: ROOM_ID,
      thread_id: threadId,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(current?.root_message_id ? { root_message_id: current.root_message_id } : {}),
      created_at: current?.created_ms ?? now,
      updated_at: now,
    };
    if (utf8Bytes(JSON.stringify(record)) > this.config.maxThreadMetadataBytes) throw new StoreError("too_large", "thread metadata is too large");
    return record;
  }

  private commitThreadMutation(input: DomainMutationInput, digest: string, now: number, historyFloor?: number): MutationCommit {
    const params = input.params;
    if (params.root_message_id !== undefined && typeof params.thread_id === "string") {
      throw new StoreError("invalid_params", "root_message_id cannot be supplied when editing a thread");
    }
    const requested = params.thread_id;
    if (requested !== undefined && typeof requested !== "string") throw new StoreError("invalid_params", "thread_id must be a string");
    if (requested === undefined) {
      const count = this.metaNumber("thread_count");
      if (count >= this.config.maxThreads) throw new StoreError("denied", "thread_limit");
      const threadId = this.nextThreadId();
      let rootMessageId: string | undefined;
      if (params.root_message_id !== undefined) {
        if (typeof params.root_message_id !== "string") throw new StoreError("invalid_params", "root_message_id must be a string");
        if (!this.currentMessage(params.root_message_id, historyFloor)) throw new StoreError("invalid_params", "unknown or expired root message");
        rootMessageId = params.root_message_id;
      }
      const record = this.threadMetadata(input, threadId, now);
      this.rawExec(
        "INSERT INTO threads (room_id, thread_id, title, summary, root_message_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ROOM_ID,
        threadId,
        record.title ?? null,
        record.summary ?? null,
        rootMessageId ?? null,
        now,
        now,
      );
      this.rawExec("INSERT OR REPLACE INTO _meta (key, value) VALUES ('thread_count', ?)", String(this.metaNumber("thread_count") + 1));
      const result = { thread_id: threadId };
      this.commitStoredResult(input.userId, input.requestId, digest, input.method ?? "thread", result, undefined, now + this.config.dedupTtlMs);
      return { result, thread: { ...record, ...(rootMessageId ? { root_message_id: rootMessageId } : {}) } } as MutationCommit & { thread: StoreThreadRecord };
    }
    if (params.root_message_id !== undefined) throw new StoreError("invalid_params", "root_message_id cannot be changed");
    const current = this.threadRow(requested);
    if (!current) throw new StoreError("invalid_params", "unknown thread");
    if (params.title === undefined && params.summary === undefined) throw new StoreError("invalid_params", "thread edit needs title or summary");
    const record = this.threadMetadata(input, requested, now, current);
    this.rawExec(
      "UPDATE threads SET title = ?, summary = ?, updated_ms = ? WHERE room_id = ? AND thread_id = ?",
      record.title ?? null,
      record.summary ?? null,
      now,
      ROOM_ID,
      requested,
    );
    const result = { thread_id: requested };
    this.commitStoredResult(input.userId, input.requestId, digest, input.method ?? "thread", result, undefined, now + this.config.dedupTtlMs);
    return { result, thread: record } as MutationCommit & { thread: StoreThreadRecord };
  }

  private commitNickMutation(input: DomainMutationInput, digest: string, now: number): MutationCommit {
    const name = input.params.name;
    if (typeof name !== "string") throw new StoreError("invalid_params", "name must be a string");
    ensureText(name, "name", this.config.maxNameBytes);
    if ([...name].length > this.config.maxNameCodePoints) throw new StoreError("too_large", "name is too long");
    const existing = this.identityRow(input.userId);
    if (!existing) throw new StoreError("denied", "Only registered users may change their name");
    this.rawExec("UPDATE identities SET name = ?, updated_ms = ? WHERE user_id = ?", name, now, input.userId);
    const result = { name };
    this.commitStoredResult(input.userId, input.requestId, digest, input.method ?? "nick", result, undefined, now + this.config.dedupTtlMs);
    return { result };
  }

  /** Runtime adapter: accepts the richer pre-normalized input shape. */
  mutate(input: StoreMutationInput, digest?: string): StoreMutationResult {
    const params: Record<string, unknown> = clone(input.params);
    const domain: DomainMutationInput = {
      userId: input.userId,
      requestId: input.requestId,
      digest: digest ?? input.digest,
      method: input.method === "message" || input.method === "thread" || input.method === "nick" ? input.method : "message",
      params,
      identity: input.identity,
      now: input.now ?? this.clock.now(),
      ipKey: input.ipKey,
    };
    const commit = this.commitMutation(domain);
    const internal = commit as MutationCommit & { transition?: Transition };
    return {
      result: commit.result as Record<string, string>,
      ...(internal.transition ? { transition: clone(internal.transition) } : commit.logId && commit.message ? {
        transition: {
          room_id: ROOM_ID,
          log_id: commit.logId,
          commit_ms: input.now ?? this.clock.now(),
          message_id: commit.messageId ?? String(commit.result.message_id),
          message: commit.message as MessageSnapshot,
        },
      } : {}),
      ...(commit.deduplicated ? { deduplicated: true } : {}),
      ...("thread" in commit ? { thread: (commit as MutationCommit & { thread: StoreThreadRecord }).thread } : {}),
    };
  }

  mutateThread(input: StoreMutationInput, digest?: string): StoreMutationResult {
    const params: Record<string, unknown> = {
      ...clone(input.params),
      room_id: input.roomId ?? (typeof input.params.room_id === "string" ? input.params.room_id : ROOM_ID),
      ...(input.thread?.threadId !== undefined ? { thread_id: input.thread.threadId } : {}),
      ...(input.thread?.title !== undefined ? { title: input.thread.title } : {}),
      ...(input.thread?.summary !== undefined ? { summary: input.thread.summary } : {}),
      ...(input.thread?.rootMessageId !== undefined ? { root_message_id: input.thread.rootMessageId } : {}),
    };
    const domain: DomainMutationInput = {
      userId: input.userId,
      requestId: input.requestId,
      digest: digest ?? input.digest ?? digestOperation("thread", params),
      method: "thread",
      params,
      identity: { user_id: input.userId, ...(input.tier === "registered" ? { tier: "registered" as const } : {}) },
      now: input.now ?? this.clock.now(),
      ipKey: input.ipKey,
    };
    const commit = this.commitMutation(domain) as MutationCommit & { thread?: StoreThreadRecord };
    return {
      result: commit.result as Record<string, string>,
      ...(commit.deduplicated ? { deduplicated: true } : {}),
      ...(commit.thread ? { thread: commit.thread } : {}),
    };
  }

  listThreads(): StoreThreadRecord[] {
    return this.getThreads();
  }

  /** Compatibility helper used by the runtime's thread request path. */
  createThread(input: DomainMutationInput): MutationCommit {
    if (input.method !== "thread") throw new StoreError("invalid_params", "thread mutation required");
    return this.commitMutation(input);
  }

  history(query: DomainHistoryQuery): HistoryPage {
    this.ensureReady();
    if (query.roomId !== ROOM_ID) throw new StoreError("invalid_params", "unknown room");
    const operationNow = query.now ?? this.clock.now();
    return this.reserved({
      ...this.config.historyCost,
      reads: Math.max(256, this.config.historyCost.reads ?? 0),
      writes: Math.max(64, this.config.historyCost.writes ?? 0),
    }, false, operationNow, () => {
      const now = this.effectiveNow(operationNow);
      return this.transaction(() => {
        if (query.userId && query.ipKey) {
          this.chargeEvent("history", `user:${query.userId}`, "history", now, this.config.historyRequestsPerUserMinute, "History request limit reached");
          this.chargeEvent("history", `ip:${query.ipKey}`, "history", now, this.config.historyRequestsPerIpMinute, "History request limit reached");
        }
        return this.historyPageInternal({
          roomId: ROOM_ID,
          after: query.after === undefined ? undefined : numericBigInt(query.after, "after"),
          before: query.before === undefined ? undefined : numericBigInt(query.before, "before"),
          limit: query.limit,
          threadId: query.threadId,
          maxBytes: Math.min((query as DomainHistoryQuery & { maxBytes?: number }).maxBytes || this.config.maxHistoryResponseBytes, this.config.maxHistoryResponseBytes),
          now,
        });
      });
    });
  }

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

  private historyPageInternal(query: StoreHistoryQuery): StoreHistoryResult {
    if (query.roomId && query.roomId !== ROOM_ID) throw new StoreError("invalid_params", "unknown room");
    if (query.threadId !== undefined && !this.threadRow(query.threadId)) throw new StoreError("invalid_params", "unknown thread");
    const room = this.roomRow();
    const floor = room.history_floor;
    const head = room.last_log_id;
    const after = query.after === undefined ? undefined : numericId(query.after, "after");
    const before = query.before === undefined ? undefined : numericId(query.before, "before");
    const lower = Math.max(floor, after ?? floor);
    const upper = Math.min(head, before ?? head);
    const limit = positiveLimit(query.limit, this.config.historyDefaultLimit, this.config.maxHistoryLimit);
    const maxBytes = Math.min(query.maxBytes ?? this.config.maxHistoryResponseBytes, this.config.maxHistoryResponseBytes);
    const latestLogId = idString(head);
    const retainedHistoryLogId = historyLogId(head, floor);
    if (lower > upper || head === 0 || floor > head) {
      return { entries: [], more: false, latest_log_id: latestLogId, history_log_id: retainedHistoryLogId };
    }
    const forward = after !== undefined;
    const sourceLimit = limit + 1;
    const params: unknown[] = [ROOM_ID, lower, upper];
    let sql: string;
    if (query.threadId === undefined) {
      sql = `SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
        FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ?
        ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`;
      params.push(sourceLimit);
    } else {
      // UNION keeps the two membership predicates on their respective indexes
      // and removes duplicate rows when before and after membership are equal.
      sql = `SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
        FROM (
          SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
          FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ? AND previous_thread_id = ?
          UNION
          SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
          FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ? AND thread_id = ?
        ) ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`;
      params.splice(0, params.length,
        ROOM_ID, lower, upper, query.threadId,
        ROOM_ID, lower, upper, query.threadId,
        sourceLimit,
      );
    }
    let rows: RawTransitionRow[];
    if (query.threadId === undefined) {
      rows = this.rawRows<RawTransitionRow>(sql, ...params);
    } else {
      // Keep each directional membership lookup bounded independently.  A
      // LIMIT on the outer UNION does not bound either branch's index scan;
      // two indexed slices do, and merging the at-most-(limit+1) rows here
      // preserves the same inclusive ordering and duplicate suppression.
      const branchSql = `SELECT room_id, log_id, commit_ms, message_id, snapshot_json, previous_thread_id, thread_id
        FROM transitions WHERE room_id = ? AND log_id >= ? AND log_id <= ? AND %s = ?
        ORDER BY log_id ${forward ? "ASC" : "DESC"} LIMIT ?`;
      const beforeRows = this.rawRows<RawTransitionRow>(
        branchSql.replace("%s", "previous_thread_id"),
        ROOM_ID,
        lower,
        upper,
        query.threadId,
        sourceLimit,
      );
      const afterRows = this.rawRows<RawTransitionRow>(
        branchSql.replace("%s", "thread_id"),
        ROOM_ID,
        lower,
        upper,
        query.threadId,
        sourceLimit,
      );
      const byLogId = new Map<number, RawTransitionRow>();
      for (const row of [...beforeRows, ...afterRows]) byLogId.set(row.log_id, row);
      rows = [...byLogId.values()].sort((left, right) => forward ? left.log_id - right.log_id : right.log_id - left.log_id).slice(0, sourceLimit);
    }
    const selected: StoreHistoryEntry[] = [];
    // The runtime wraps this result in a JSON-RPC response.  Reserve a fixed
    // envelope allowance for jsonrpc/id/result keys, decimal IDs, commas and
    // first/last/more fields.  An empty page is always valid even when a
    // caller supplies a tiny maxBytes value, so apply this allowance only
    // while considering a non-empty entry.
    // A 128-byte request ID can require 768 JSON bytes when escaped.
    const responseOverhead = 1024;
    let bytes = utf8Bytes(JSON.stringify({ entries: [], more: false, latest_log_id: latestLogId, history_log_id: retainedHistoryLogId }));
    let stoppedForBytes = false;
    for (const row of rows.slice(0, sourceLimit)) {
      const entry: StoreHistoryEntry = { log_id: idString(row.log_id), message: parseJson<MessageSnapshot>(row.snapshot_json) };
      const entryBytes = utf8Bytes(JSON.stringify(entry));
      if (entryBytes + bytes + responseOverhead + 1 > maxBytes) {
        if (selected.length === 0) throw new StoreError("too_large", "history entry exceeds response budget");
        stoppedForBytes = true;
        break;
      }
      selected.push(entry);
      bytes += entryBytes + 1;
      if (selected.length >= limit) break;
    }
    const more = stoppedForBytes || rows.length > selected.length;
    if (!forward) selected.reverse();
    if (!selected.length) {
      return { entries: [], more: false, latest_log_id: latestLogId, history_log_id: retainedHistoryLogId };
    }
    return {
      entries: selected,
      first_id: selected[0].log_id,
      last_id: selected[selected.length - 1].log_id,
      more,
      latest_log_id: latestLogId,
      history_log_id: retainedHistoryLogId,
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

  runCleanup(now = this.clock.now()): StoreCleanupResult {
    this.ensureReady();
    // A challenge deadline is not an hourly cleanup. Its cheap due check must
    // not consume the reservation for a complete deletion batch.
    let gate: { maintenance: RawMaintenanceRow; room: RawRoomRow; effective: number };
    try {
      gate = this.reserved({ reads: 8, writes: 2 }, true, now, () => ({
        maintenance: this.maintenanceRow(), room: this.roomRow(), effective: this.effectiveNow(now),
      }));
    } catch (error) {
      if (error instanceof StoreError && error.code === "retry_after") this.deferCleanup(Math.max(now, this.lastEffectiveMs));
      throw error;
    }
    const { maintenance, room, effective } = gate;
    const due = Math.max(maintenance.next_cleanup_ms, this.deferredCleanupUntil);
    const empty = (nextDue: number): StoreCleanupResult => ({
      history_floor: idString(room.history_floor), latest_id: idString(room.last_log_id),
      deleted_transitions: 0, deleted_messages: 0, deleted_requests: 0, deleted_limiters: 0,
      next_due_ms: nextDue, did_work: false,
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
    let floor = room.history_floor;
    // Commit the coverage boundary/job before physical deletion. A failed
    // deletion leaves logically expired rows hidden and an idempotent job.
    this.transaction(() => {
      const pending = this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM transitions WHERE room_id = ? AND log_id < ? ORDER BY log_id LIMIT 1", ROOM_ID, floor,
      );
      const expired = pending.length ? [] : this.rawRows<{ log_id: number }>(
        `SELECT log_id FROM transitions INDEXED BY transitions_retention_idx
         WHERE room_id = ? AND commit_ms < ? AND log_id >= ?
         ORDER BY commit_ms, log_id LIMIT ?`, ROOM_ID, cutoff, floor, batch,
      );
      if (expired.length) floor = Math.max(floor, expired[expired.length - 1].log_id + 1);
      this.rawExec("UPDATE room_state SET history_floor = ? WHERE room_id = ?", floor, ROOM_ID);
      this.rawExec("UPDATE maintenance SET cleanup_cutoff_ms = ?, cleanup_cursor = ?, next_cleanup_ms = ? WHERE id = 1", cutoff, floor, effective + 1000);
      this.assertReservation(reserved, beforeReads, beforeWrites);
    });
    const result = this.transaction(() => {
      let remaining = batch;
      const expired = this.rawRows<{ log_id: number }>(
        "SELECT log_id FROM transitions WHERE room_id = ? AND log_id < ? ORDER BY log_id LIMIT ?", ROOM_ID, floor, remaining,
      );
      for (const row of expired) this.rawExec("DELETE FROM transitions WHERE room_id = ? AND log_id = ?", ROOM_ID, row.log_id);
      remaining -= expired.length;
      const messages = remaining > 0 ? this.rawRows<{ message_id: string }>(
        "SELECT message_id FROM messages WHERE room_id = ? AND latest_log_id < ? ORDER BY latest_log_id LIMIT ?", ROOM_ID, floor, remaining,
      ) : [];
      for (const row of messages) this.rawExec("DELETE FROM messages WHERE room_id = ? AND message_id = ? AND latest_log_id < ?", ROOM_ID, row.message_id, floor);
      remaining -= messages.length;
      const requests = remaining > 0 ? this.rawRows<{ user_id: string; request_id: string }>(
        "SELECT user_id, request_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT ?", effective, remaining,
      ) : [];
      for (const row of requests) this.rawExec("DELETE FROM accepted_requests WHERE user_id = ? AND request_id = ?", row.user_id, row.request_id);
      remaining -= requests.length;
      // Principal authority is independent of chat retention: keep the current
      // UTC day's counters and every still-live rolling-minute event.
      const limiterCutoff = Math.min(Math.floor(effective / 86_400_000) * 86_400_000, effective - POST_WINDOW_MS);
      const limiters = remaining > 0 ? this.rawRows<{ scope: string; principal_key: string }>(
        "SELECT scope, principal_key FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT ?", limiterCutoff, remaining,
      ) : [];
      for (const row of limiters) this.rawExec("DELETE FROM principal_limits WHERE scope = ? AND principal_key = ?", row.scope, row.principal_key);
      if (limiters.length) this.rawExec("UPDATE _meta SET value = ? WHERE key = 'principal_limit_count'", String(Math.max(0, this.metaNumber("principal_limit_count") - limiters.length)));
      const hasMore =
        this.rawRows("SELECT log_id FROM transitions INDEXED BY transitions_retention_idx WHERE room_id = ? AND commit_ms < ? ORDER BY commit_ms, log_id LIMIT 1", ROOM_ID, cutoff).length > 0 ||
        this.rawRows("SELECT message_id FROM messages WHERE room_id = ? AND latest_log_id < ? ORDER BY latest_log_id LIMIT 1", ROOM_ID, floor).length > 0 ||
        this.rawRows("SELECT user_id FROM accepted_requests WHERE expires_ms <= ? ORDER BY expires_ms LIMIT 1", effective).length > 0 ||
        this.rawRows("SELECT scope FROM principal_limits WHERE updated_ms < ? ORDER BY updated_ms LIMIT 1", limiterCutoff).length > 0;
      const nextDue = effective + (hasMore ? 1000 : this.config.cleanupIntervalMs);
      this.rawExec("UPDATE maintenance SET next_cleanup_ms = ?, cleanup_cutoff_ms = ?, cleanup_cursor = ? WHERE id = 1", nextDue, hasMore ? cutoff : null, hasMore ? floor : null);
      this.assertReservation(reserved, beforeReads, beforeWrites);
      return {
        history_floor: idString(floor), latest_id: idString(room.last_log_id),
        deleted_transitions: expired.length, deleted_messages: messages.length,
        deleted_requests: requests.length, deleted_limiters: limiters.length,
        next_due_ms: nextDue,
        did_work: floor !== room.history_floor || expired.length + messages.length + requests.length + limiters.length > 0,
      };
    });
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
      if (existing !== null && Number.isFinite(existing) && existing > effective && existing <= dueAt) return;
      actualReads += 2; actualWrites += 2;
      this.observed.reads += 2; this.observed.writes += 2;
      await setAlarm.call(this.durableStorage, dueAt);
    } finally {
      this.assertReservation(reserved, this.observed.reads - actualReads, this.observed.writes - actualWrites);
    }
  }

  /** Compatibility adapter for older runtime callers during migration. */
  setAlarmTask(task: { kind: "auth" | "cleanup"; dueAt: number; connectionId?: string }): void {
    const socketDeadline = task.kind === "auth" ? task.dueAt : undefined;
    void this.scheduleAlarm(socketDeadline, this.clock.now()).catch(() => undefined);
  }
}
