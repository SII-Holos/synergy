export type MigrationOwner =
  | { kind: "session"; scopeID: string; sessionID: string }
  | { kind: "operation"; scopeID: string; operationID: string }

export interface Migration {
  id: string
  description: string
  up(progress: (current: number, total: number, phase?: number) => void): Promise<void>
  upgradeConfig?(config: Record<string, unknown>): void
  upgradeRecord?(key: string[], record: Record<string, unknown>): void
  down?(progress: (current: number, total: number) => void): Promise<void>
  dependsOn?: string[]
  version?: string
  domain?: string
  scope?: "global" | "scope" | "session" | "derived"
  onAccess?: true
  isApplied?(): Promise<boolean>
  execution?: "startup" | "session" | "owner" | "record" | "after-convergence" | "maintenance"
  upOwner?(owner: MigrationOwner, progress: (current: number, total: number) => void): Promise<void>
  upSession?(
    owner: { scopeID: string; sessionID: string },
    progress: (current: number, total: number) => void,
  ): Promise<void>
}

export interface RunOptions {
  dryRun?: boolean
  targetDomain?: string
  rollbackId?: string
  output?: "silent" | "summary" | "interactive"
  reporter?: MigrationReporter
  maintenance?: boolean
  signal?: AbortSignal
}

export interface RunResult {
  completed: Migration[]
  skipped: Migration[]
  rolledBack: Migration[]
  domain: string
}

export interface MigrationSummary {
  totalDomains: number
  upToDateDomains: number
  completed: number
  deferred?: number
  dryRun: number
  failed: number
}

export interface MigrationReporter {
  summary(summary: MigrationSummary): void
  started?(input: { domain: string; migration: Migration }): void
  progress?(input: { domain: string; migration: Migration; current: number; total: number; dryRun: boolean }): void
}

export interface MigrationContext {
  log: (msg: string) => void
  appVersion: string
  dryRun: boolean
}
