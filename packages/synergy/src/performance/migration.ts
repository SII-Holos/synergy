export namespace PerformanceMigration {
  export const schemaVersion = 1
  export const metaKeys = ["schemaVersion", "createdAt", "lastRetentionRunAt", "lastWalCheckpointAt"] as const

  export function versionString() {
    return String(schemaVersion)
  }
}
