export interface MetaSynergyMigration {
  id: string
  description: string
  run(): Promise<void>
}
