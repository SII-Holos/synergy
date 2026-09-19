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
  onMaintenanceBudget?: (timeoutMs: number) => void
}

export interface SqlConnection {
  query<Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[], options?: SqlQueryOptions): Promise<Row[]>
}

export interface SqlDriver extends SqlConnection {
  readonly backend: "sqlite" | "postgres"
  transaction<T>(
    body: (connection: SqlConnection) => Promise<T>,
    options?: { readOnly?: boolean; operationID?: string },
  ): Promise<T>
  close(): Promise<void>
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
  action: "open" | "query" | "close" | "maintain"
  filename?: string
  readonly?: boolean
  reader?: boolean
  statement?: string
  values?: SqlValue[]
  maintenance?: boolean
  maintain?: SqliteMaintenanceRequest
}

export type SqliteResponse = {
  id: number
  rows?: SqlRow[]
  maintain?: SqliteMaintenanceResult
  error?: { name: string; message: string; code?: string }
}
