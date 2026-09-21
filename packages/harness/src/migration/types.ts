export interface Migration {
  id: string
  description: string
  up(progress: (current: number, total: number, phase?: number) => void): Promise<void>
  down?(progress: (current: number, total: number) => void): Promise<void>
  dependsOn?: string[]
  version?: string
  domain?: string
  scope?: "global" | "scope" | "session" | "derived"
  isApplied?(): Promise<boolean>
  execution?: "startup" | "session" | "after-convergence" | "maintenance"
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
