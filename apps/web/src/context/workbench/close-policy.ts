import type { WorkbenchPanelTab } from "@/plugin/registries/workbench-panel-registry"

export function createWorkbenchClosePolicy(confirmDiscard: (tab: WorkbenchPanelTab) => Promise<boolean>) {
  const handlers = new Map<string, Set<() => boolean | Promise<boolean>>>()
  const key = (session: string, tab: string) => JSON.stringify([session, tab])
  return {
    register(session: string, tab: string, handler: () => boolean | Promise<boolean>) {
      const id = key(session, tab)
      const group = handlers.get(id) ?? new Set()
      handlers.set(id, group)
      group.add(handler)
      return () => {
        group.delete(handler)
        if (!group.size) handlers.delete(id)
      }
    },
    async canClose(session: string, tab: WorkbenchPanelTab) {
      const group = [...(handlers.get(key(session, tab.id)) ?? [])]
      for (const handler of group) if (!(await handler())) return false
      return !group.length && tab.dirty ? confirmDiscard(tab) : true
    },
  }
}
