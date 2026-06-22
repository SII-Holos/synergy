/**
 * Browser state migration module.
 * Currently no migrations needed (v1 schema). This module exists as a
 * designated location for versioned state upgrades when storage format changes.
 *
 * Example future usage:
 *   BrowserMigration.run(owner).catch(log)
 */
export namespace BrowserMigration {
  export async function run(): Promise<void> {
    // No migrations yet
  }
}
