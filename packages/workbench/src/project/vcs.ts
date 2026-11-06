import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { AsyncLocalStorage } from "node:async_hooks"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
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

  async function currentBranch() {
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
      if (FileView.native()) return await query()
      const owner = WorkspaceState.current()!
      const workspace = await WorkspaceCatalog.get(owner.id!, owner.scopeID)
      if (workspace.binding.generation !== owner.generation || workspace.activeMount?.state !== "active") return
      await using resources = await EnvironmentResources.resolve({
        scopeID: owner.scopeID,
        workspaceID: owner.id,
        workspaceGeneration: owner.generation,
        needs: { workspace: true },
      })
      return await EnvironmentResources.provide(resources, `vcs:${crypto.randomUUID()}`, query)
    } catch (error) {
      log.debug("branch unavailable", { error })
      return undefined
    }
  }

  const state = WorkspaceState.create(
    async () => {
      const watcher = VcsBranchWatcher.create({
        debounceMs: 50,
        resolve: AsyncLocalStorage.bind(currentBranch),
        onChange: (branch, previous) => {
          log.info("branch changed", { from: previous, to: branch })
          WorkspaceEvents.publish(Event.BranchUpdated, { branch })
        },
      })
      const current = await watcher.start()
      log.info("initialized", { branch: current })

      const unsubscribe = WorkspaceEvents.subscribe(FileWatcher.Event.Updated, (event) => {
        watcher.notify(event.properties.resync ? ".git/HEAD" : event.properties.file)
      })

      return {
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

  export async function init() {
    return state()
  }

  export async function branch() {
    return await state().then((s) => s.branch())
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
