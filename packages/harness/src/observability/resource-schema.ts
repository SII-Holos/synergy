import type { Database } from "bun:sqlite"

export namespace ObservabilityResourceSchema {
  export const v5Columns = [
    ["cgroup_current_bytes", "INTEGER"],
    ["cgroup_high_bytes", "INTEGER"],
    ["cgroup_max_bytes", "INTEGER"],
    ["cgroup_peak_bytes", "INTEGER"],
    ["cgroup_oom_count", "INTEGER"],
    ["cgroup_oom_kill_count", "INTEGER"],
    ["service_memory_rss_bytes", "INTEGER"],
    ["service_memory_source", "TEXT"],
    ["service_memory_completeness", "TEXT"],
  ] as const

  export const v5Indexes = [
    "CREATE INDEX IF NOT EXISTS idx_obs_issues_status_last_seen ON obs_issues(status,last_seen_time)",
  ] as const

  export function applyV5(db: Database) {
    const existing = new Set(
      (db.query("PRAGMA table_info(obs_resource_samples)").all() as Array<{ name: string }>).map((row) => row.name),
    )
    for (const [name, type] of v5Columns) {
      if (existing.has(name)) continue
      db.exec(`ALTER TABLE obs_resource_samples ADD COLUMN ${name} ${type}`)
    }
    for (const sql of v5Indexes) db.exec(sql)
  }
}
