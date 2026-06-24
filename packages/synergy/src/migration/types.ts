export interface Migration {
  id: string
  description: string
  up(progress: (current: number, total: number) => void): Promise<void>
  down?(progress: (current: number, total: number) => void): Promise<void>
  dependsOn?: string[]
  version?: string
  domain?: string
}

export interface RunOptions {
  dryRun?: boolean
  targetDomain?: string
  rollbackId?: string
  output?: "silent" | "summary" | "interactive"
  reporter?: MigrationReporter
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
  dryRun: number
  failed: number
}

export interface MigrationReporter {
  summary(summary: MigrationSummary): void
  progress?(input: { domain: string; migration: Migration; current: number; total: number; dryRun: boolean }): void
}

export interface MigrationContext {
  log: (msg: string) => void
  appVersion: string
  dryRun: boolean
}
