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
}

export interface RunResult {
  completed: Migration[]
  skipped: Migration[]
  rolledBack: Migration[]
  domain: string
}

export interface MigrationContext {
  log: (msg: string) => void
  appVersion: string
  dryRun: boolean
}
