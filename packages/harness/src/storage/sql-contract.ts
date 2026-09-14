export type SqlValue = string | number | bigint | Uint8Array | null
export type SqlRow = Record<string, SqlValue>

export interface SqlConnection {
  query<Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[]): Promise<Row[]>
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

export type SqliteRequest = {
  id: number
  action: "open" | "query" | "close"
  filename?: string
  readonly?: boolean
  reader?: boolean
  statement?: string
  values?: SqlValue[]
}

export type SqliteResponse = {
  id: number
  rows?: SqlRow[]
  error?: { name: string; message: string; code?: string }
}
