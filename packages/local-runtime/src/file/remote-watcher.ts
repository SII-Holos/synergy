import { AsyncLocalStorage } from "node:async_hooks"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace RemoteFileWatcher {
  const log = Log.create({ service: "workspace.observation" })
  const state = WorkspaceState.create(
    () => {
      const workspace = WorkspaceState.current()!
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let pending: Promise<void> | undefined
      let signature: string | undefined
      let failed = false
      const start = (resync: () => Promise<void>) => {
        if (pending || timer) return pending
        const poll = AsyncLocalStorage.bind(async () => {
          try {
            const info = await WorkspaceCatalog.get(workspace.id!, workspace.scopeID)
            if (info.binding.generation !== workspace.generation || info.lifecycle !== "active") {
              controller.abort()
              return
            }
            const files = info.activeMount?.state === "active" ? await WorkspaceMounts.connect(info) : undefined
            const cursor = files?.observe
              ? await files.observe(WorkspaceMounts.reference(info), controller.signal)
              : undefined
            controller.signal.throwIfAborted()
            const next = JSON.stringify([info.revision, info.content, info.activeMount, cursor])
            if (signature !== next || failed) {
              await resync()
              signature = next
            }
            failed = false
          } catch (error) {
            if (controller.signal.aborted) return
            if (!failed) {
              log.warn("Workspace observation unavailable", { workspaceID: workspace.id, error })
              await resync()
            }
            failed = true
          } finally {
            if (!controller.signal.aborted) {
              timer = setTimeout(() => {
                timer = undefined
                pending = poll()
              }, 1000)
              timer.unref()
            }
          }
        })
        pending = poll()
        return pending
      }
      return {
        start,
        async dispose() {
          controller.abort()
          if (timer) clearTimeout(timer)
          await pending
        },
      }
    },
    (current) => current.dispose(),
  )

  export async function init(resync: () => Promise<void>) {
    await state().start(resync)
  }
}
