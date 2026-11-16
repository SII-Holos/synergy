import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { $ } from "bun"
import path from "path"
import { z } from "zod"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { FileWatcher } from "@ericsanchezok/synergy-local-runtime/file/watcher"
import { Filesystem } from "@ericsanchezok/synergy-harness/util/filesystem"
import { VcsBranchWatcher } from "./vcs-branch-watcher"
import { FileView } from "@ericsanchezok/synergy-local-runtime/file/view"
import { WorktreeProcess } from "@ericsanchezok/synergy-local-runtime/workspace/process"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  const registration = RuntimeContext.state<{ origin?: ReturnType<typeof EnvironmentOrigin.registerHost> }>(() => ({}))

  export function register() {
    registration().origin ??= EnvironmentOrigin.registerHost("vcs")
  }

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        ...WorkspaceEvents.Fields,
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  async function currentBranch(
    owner: { id: string; scopeID: string; generation: number },
    origin: EnvironmentOrigin.Token,
    id: string,
  ) {
    const query = async () => {
      const result = await WorktreeProcess.run({
        command: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        directory: FileView.directory(),
        roots: [],
        metadata: true,
        env: { GIT_OPTIONAL_LOCKS: "0" },
      })
      return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
    }
    try {
      const workspace = await WorkspaceCatalog.get(owner.id, owner.scopeID)
      if (workspace.binding.generation !== owner.generation) return
      if (workspace.backend?.provider === "objects" && workspace.activeMount?.state !== "active") return
      await using resources = await EnvironmentResources.resolve({
        scopeID: owner.scopeID,
        workspaceID: owner.id,
        workspaceGeneration: owner.generation,
        origin,
        needs: { workspace: true },
      })
      return await EnvironmentResources.provide(resources, id, async () => {
        const workspace = EnvironmentResources.localFiles()
          ? await WorkspaceBinding.validate(owner.id, owner.scopeID, owner.generation)
          : null
        return WorkspaceAccess.task({ workspace }, query)
      })
    } catch (error) {
      log.debug("branch unavailable", { error })
      return undefined
    }
  }

  const state = WorkspaceState.create(
    async () => {
      const selected = WorkspaceState.current()!
      const owner = { id: selected.id!, scopeID: selected.scopeID, generation: selected.generation! }
      const scope = structuredClone(ScopeContext.current.scope)
      if (scope.id !== owner.scopeID) throw new Error("VCS observation belongs to another Scope")
      const host = registration().origin
      if (!host) throw new Error("VCS observation requires a composed Host origin")
      const ownership = EnvironmentOrigin.selected(host.capture(`vcs-owner:${crypto.randomUUID()}`))
      const runtime = RuntimeContext.current()
      const { store, artifactDirectory, artifactObjects } = Storage.current()
      const run = <T>(fn: () => Promise<T>) =>
        RuntimeContext.exit(() =>
          runtime.run(() =>
            Storage.provide({ store, artifactDirectory, artifactObjects }, () => {
              ownership.assertCurrent()
              return ScopeContext.provide({ scope, workspace: null, fn: () => WorkspaceState.provide(owner, fn) })
            }),
          ),
        )
      const watcher = VcsBranchWatcher.create({
        debounceMs: 50,
        resolve: () =>
          run(() => {
            const id = `vcs:${crypto.randomUUID()}`
            return currentBranch(owner, host.capture(id), id)
          }),
        onChange: (branch, previous) =>
          run(async () => {
            log.info("branch changed", { from: previous, to: branch })
            await WorkspaceEvents.publish(Event.BranchUpdated, { branch })
          }),
      })
      const current = await watcher.start()
      log.info("initialized", { branch: current })

      const unsubscribe = await run(async () =>
        WorkspaceEvents.subscribe(FileWatcher.Event.Updated, (event) => {
          watcher.notify(event.properties.resync ? ".git/HEAD" : event.properties.file)
        }),
      )

      return {
        assertCurrent: ownership.assertCurrent,
        branch: async () => watcher.current(),
        unsubscribe,
        watcher,
      }
    },
    async (state) => {
      state.unsubscribe?.()
      await state.watcher?.dispose()
    },
  )

  async function admitted<T>(fn: () => Promise<T>) {
    const selected = EnvironmentResources.current()
    const workspace = WorkspaceState.current()
    const owner = workspace && { id: workspace.id!, scopeID: workspace.scopeID, generation: workspace.generation! }
    const origin = selected?.origin
    if (selected && !origin) throw new Error("VCS observation requires its original resource origin")
    const target = {
      scopeID: ScopeContext.current.scope.id,
      environmentID: selected?.environment?.id ?? selected?.selection?.environmentID ?? undefined,
    }
    if (origin) await EnvironmentOrigin.assertAdmission(origin, target)
    const value = await (owner ? WorkspaceState.provide(owner, fn) : fn())
    if (origin) await EnvironmentOrigin.assertAdmission(origin, target)
    return value
  }

  export async function init() {
    return admitted(async () => {
      const value = await state()
      value.assertCurrent()
      return value
    })
  }

  export async function branch() {
    return admitted(async () => {
      const value = await state()
      value.assertCurrent()
      return value.branch()
    })
  }

  export async function initIfNeeded(directory: string, options?: { searchParents?: boolean }) {
    const gitDir = path.join(directory, ".git")
    const stat = await Bun.file(gitDir)
      .stat()
      .catch(() => undefined)
    if (stat) return false

    if (options?.searchParents !== false) {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
      const found = await matches.next().then((x) => x.value)
      await matches.return()
      if (found) return false
    }

    log.info("initializing git repository", { directory })
    await $`git init`.cwd(directory).quiet()
    await $`git commit --allow-empty -m "Initial commit"`.cwd(directory).quiet()
    return true
  }
}
