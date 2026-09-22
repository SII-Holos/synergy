import { RuntimeContext } from "../lifecycle/context"
import type { MigrationContext } from "./types"

const runtimeState = RuntimeContext.state(() => ({
  activeCtx: undefined as MigrationContext | undefined,
}))

export function setActiveMigrationContext(ctx: MigrationContext | undefined): void {
  const instanceState = runtimeState()

  instanceState.activeCtx = ctx
}
