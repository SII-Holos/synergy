import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { $ } from "bun"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { ScopeContext } from "@/scope/context"
import { ScopedState } from "@/scope/scoped-state"
import { FileWatcher } from "@/file/watcher"
import { Filesystem } from "@/util/filesystem"
import { VcsBranchWatcher } from "./vcs-branch-watcher"

const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
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
    return $`git rev-parse --abbrev-ref HEAD`
      .quiet()
      .nothrow()
      .cwd(ScopeContext.current.directory)
      .text()
      .then((x) => x.trim())
      .catch(() => undefined)
  }

  const state = ScopedState.create(
    async () => {
      if (ScopeContext.current.scope.type !== "project" || ScopeContext.current.scope.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined, watcher: undefined }
      }
      const watcher = VcsBranchWatcher.create({
        debounceMs: 50,
        resolve: currentBranch,
        onChange: (branch, previous) => {
          log.info("branch changed", { from: previous, to: branch })
          Bus.publish(Event.BranchUpdated, { branch })
        },
      })
      const current = await watcher.start()
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (event) => {
        watcher.notify(event.properties.file)
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
