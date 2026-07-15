import { Log } from "@/util/log"

export namespace ContinuationWait {
  const log = Log.create({ service: "session.continuation-wait" })

  export interface Info {
    owner: string
    id: string
    description?: string
  }

  export interface Provider {
    id: string
    list(sessionID: string): Promise<Info[]>
  }

  const providers: Provider[] = []
  let builtinsRegistered = false

  export function register(provider: Provider): void {
    if (providers.some((candidate) => candidate.id === provider.id)) return
    providers.push(provider)
  }

  export function reset(): void {
    providers.length = 0
    builtinsRegistered = false
  }

  export async function list(sessionID: string): Promise<Info[]> {
    registerBuiltins()
    const batches = await Promise.all(
      providers.map((provider) =>
        provider.list(sessionID).catch((error) => {
          log.error("continuation wait provider failed", { provider: provider.id, sessionID, error })
          return []
        }),
      ),
    )
    return batches.flat()
  }

  export async function has(sessionID: string): Promise<boolean> {
    return (await list(sessionID)).length > 0
  }

  function registerBuiltins(): void {
    if (builtinsRegistered) return
    builtinsRegistered = true
    register({
      id: "agenda",
      async list(sessionID) {
        const { SessionManager } = await import("./manager")
        const session = await SessionManager.getSession(sessionID)
        if (!session) return []
        const { AgendaSessionWakeup } = await import("../agenda/session-wakeup")
        const response = await AgendaSessionWakeup.list(sessionID, session.scope.id)
        return response.items.map((item) => ({ owner: "agenda", id: item.itemID, description: item.title }))
      },
    })
    register({
      id: "cortex",
      async list(sessionID) {
        const { Cortex } = await import("../cortex/manager")
        const active = Cortex.getTasksForSession(sessionID).filter(
          (task) => task.status === "queued" || task.status === "running",
        )
        if (active.length > 0) {
          return active.map((task) => ({ owner: "cortex", id: task.id, description: task.description }))
        }

        const { Session } = await import(".")
        const children = await Session.children(sessionID).catch(() => [])
        return children
          .filter((child) => child.cortex?.status === "queued" || child.cortex?.status === "running")
          .map((child) => ({
            owner: "cortex",
            id: child.cortex!.taskID,
            description: child.cortex!.description,
          }))
      },
    })
  }
}
