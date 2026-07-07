export interface SynergyLinkMigration {
  id: string
  description: string
  run(): Promise<void>
}
