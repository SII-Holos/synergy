export interface WorkspaceRevealState {
  interacted?: boolean
  consumed?: boolean
}

export function createWorkspaceRevealPolicy(
  since: number,
  storage?: {
    read: (id: string) => WorkspaceRevealState | undefined
    write: (id: string, value: WorkspaceRevealState) => void
  },
) {
  const tasks = new Map<string, WorkspaceRevealState & { seen: Map<string, number>; completedThrough: number }>()
  const state = (id: string) => {
    let value = tasks.get(id)
    if (!value) {
      value = { ...storage?.read(id), seen: new Map(), completedThrough: -Infinity }
      if (tasks.size >= 50) tasks.delete(tasks.keys().next().value!)
    }
    tasks.delete(id)
    tasks.set(id, value)
    return value
  }
  const persist = (id: string, value: WorkspaceRevealState) =>
    storage?.write(id, { interacted: value.interacted, consumed: value.consumed })
  return {
    interact(id: string) {
      const value = state(id)
      value.interacted = true
      persist(id, value)
    },
    request(input: {
      sessionID: string
      currentSessionID?: string
      key: string
      completedAt: number
      busy: boolean
      overlay: boolean
    }) {
      if (input.sessionID !== input.currentSessionID || input.completedAt < since) return "ignore" as const
      const task = state(input.sessionID)
      if (input.completedAt <= task.completedThrough || task.seen.has(input.key)) return "ignore" as const
      if (task.seen.size >= 64) {
        task.completedThrough = Math.max(task.completedThrough, Math.min(...task.seen.values()))
        for (const [key, completedAt] of task.seen) if (completedAt <= task.completedThrough) task.seen.delete(key)
        if (input.completedAt <= task.completedThrough) return "ignore" as const
      }
      task.seen.set(input.key, input.completedAt)
      const reveal = !task.interacted && !task.consumed && !input.busy && !input.overlay
      task.consumed = true
      persist(input.sessionID, task)
      return reveal ? ("reveal" as const) : ("notify" as const)
    },
  }
}
