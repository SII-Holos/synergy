import path from "node:path"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { GlobalBus } from "@ericsanchezok/synergy-harness/bus/global"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ResourceProfiles } from "@ericsanchezok/synergy-local-runtime/environment/profiles"

export namespace ProjectTaskDefaults {
  export const Defaults = z
    .object({
      defaultSessionWorkspace: z.enum(["main", "worktree"]).optional(),
      defaultSessionEnvironmentProfile: z.string().min(1).nullable().optional(),
    })
    .meta({ ref: "ProjectTaskDefaults" })
  export const Result = z
    .object({ defaults: Defaults, effective: Defaults, editable: z.boolean() })
    .meta({ ref: "ProjectTaskDefaultsResult" })
  export const Input = z.object({ defaults: Defaults, expected: Defaults }).meta({ ref: "ProjectTaskDefaultsInput" })
  export const Conflict = NamedError.create("ProjectTaskDefaultsConflict", z.object({ message: z.string() }))
  export const Invalid = NamedError.create("ProjectTaskDefaultsInvalid", z.object({ message: z.string() }))
  function root() {
    const scope = ScopeContext.current.scope
    return scope.type === "project" && scope.local ? path.join(scope.local.directory, ".synergy") : undefined
  }
  export async function get(): Promise<z.infer<typeof Result>> {
    const directory = root()
    return {
      defaults: directory ? Defaults.parse(await Config.domainGet("general", directory)) : {},
      effective: Defaults.parse(await Config.current()),
      editable: !!directory,
    }
  }
  export async function update(input: z.infer<typeof Input>) {
    const parsed = Input.parse(input)
    const directory = root()
    if (!directory)
      throw new Invalid({
        message: "This project inherits global settings because it has no project configuration directory.",
      })
    if (parsed.defaults.defaultSessionWorkspace === "worktree" && ScopeContext.current.scope.local?.vcs !== "git")
      throw new Invalid({ message: "Independent copies require a Git project." })
    const profile = parsed.defaults.defaultSessionEnvironmentProfile
    if (profile && !(await ResourceProfiles.list()).environments.some((item) => item.name === profile))
      throw new Invalid({ message: "The selected execution profile is unavailable. Choose a configured location." })
    const { change } = await Config.domainMutateWithChange(
      "general",
      (current) => {
        if (JSON.stringify(Defaults.parse(current)) !== JSON.stringify(parsed.expected))
          throw new Conflict({ message: "Project defaults changed. Reload them before saving again." })
        delete current.defaultSessionWorkspace
        delete current.defaultSessionEnvironmentProfile
        return { ...current, ...parsed.defaults }
      },
      { root: directory, mode: "replace-domain" },
    )
    GlobalBus().emit("event", {
      scopeID: ScopeContext.current.scope.id,
      payload: {
        type: Config.Event.Updated.type,
        properties: { scope: "project", changedFields: change.changedFields },
      },
    })
    return get()
  }
}
