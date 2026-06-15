import type { MigrationContext } from "./types"

let activeCtx: MigrationContext | undefined

export function setActiveMigrationContext(ctx: MigrationContext | undefined): void {
  activeCtx = ctx
}

export function getActiveMigrationContext(): MigrationContext | undefined {
  return activeCtx
}
