import { z } from "zod"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Workspace } from "@ericsanchezok/synergy-harness/session/types"

export namespace ScopePath {
  export const Schema = z
    .object({
      home: z.string(),
      state: z.string(),
      config: z.string(),
      worktree: z.string().nullable(),
      directory: z.string().nullable(),
      workspace: Workspace.nullable(),
    })
    .meta({ ref: "Path" })

  export function current() {
    return {
      home: Global.Path.home,
      state: Global.Path.state,
      config: Global.Path.config,
      worktree: ScopeContext.current.scope.local?.worktree ?? null,
      directory: ScopeContext.current.workspace?.path ?? null,
      workspace: ScopeContext.current.workspace,
    }
  }
}
