export type SqlValue = string | number | bigint | Uint8Array | null
export type SqlRow = Record<string, SqlValue>

export function sqlParameterBytes(values: SqlValue[]): number {
  return values.reduce<number>(
    (total, value) =>
      total +
      (typeof value === "string" ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8),
    0,
  )
}

export interface SqlQueryOptions {
  // Maintenance statements (integrity verification) legitimately run longer
  // than ordinary operations; engines may extend their deadline.
  maintenance?: boolean
  // Declares a statement that cannot be split: an index build, a table rebuild,
  // a physical integrity check, a `VACUUM`. Chunked maintenance is bounded by
  // construction and stays on the chunk budget; these are bounded only by the
  // ceiling, because their cost grows with the store and failing one at a chunk
  // deadline would roll back work that would otherwise have finished.
  unchunkable?: boolean
  onMaintenanceBudget?: (timeoutMs: number) => void
}

export interface SqlTransactionOptions {
  readOnly?: boolean
  operationID?: string
  // Declared by the caller when its body issues at most one statement. A lone
  // statement is already atomic, so an explicit transaction would only add round
  // trips to the engine; a body that reads more than once must not declare it,
  // because separate statements would then observe separate snapshots.
  singleStatement?: boolean
}

export interface SqlConnection {
  query<Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions): Promise<Row[]>
}

export interface SqlDriver extends SqlConnection {
  readonly backend: "sqlite" | "postgres"
  transaction<T>(body: (connection: SqlConnection) => Promise<T>, options?: SqlTransactionOptions): Promise<T>
  close(): Promise<void>
  // Reports a store that failed terminally and cannot serve further work, so the
  // host can escalate to its managed restart instead of serving a dead store.
  // Required rather than optional: a driver that omitted it would make
  // `Storage.onUnavailable` silently return a no-op, which is exactly how a
  // terminally failed store goes unreported. A backend that cannot raise the
  // signal must say so by declaring its own implementation.
  onUnavailable(listener: (error: Error) => void): () => void
}

export type StoreOptions = {
  namespace: string
  readonly?: boolean
  recover?: boolean
  mustExist?: boolean
} & ({ backend: "sqlite"; filename: string } | { backend: "postgres"; url: string; maxConnections?: number })

export type SqliteMaintenanceOperation = "enable-incremental-vacuum" | "reclaim"

export type SqliteMaintenanceRequest = {
  operation: SqliteMaintenanceOperation
  maxPages?: number
}

export type SqliteMaintenanceResult = {
  // True when the operation changed the physical database: a VACUUM that
  // converted the file to incremental mode, or freelist pages that were freed.
  changed: boolean
  autoVacuum: "none" | "full" | "incremental"
  releasedPages: number
  freelistPages: number
}

export type SqliteRequest = {
  id: number
  action: "open" | "query" | "close" | "ping" | "maintain"
  filename?: string
  readonly?: boolean
  reader?: boolean
  statement?: string
  values?: SqlValue[]
  maintenance?: boolean
  unchunkable?: boolean
  maintain?: SqliteMaintenanceRequest
}

export type SqliteResponse = {
  id: number
  rows?: SqlRow[]
  maintain?: SqliteMaintenanceResult
  error?: { name: string; message: string; code?: string }
}
