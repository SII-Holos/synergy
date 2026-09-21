import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { SessionCortexRuntime } from "./cortex-runtime"

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

  const runtimeState = RuntimeContext.state(() => ({
    providers: [] as Provider[],
    builtinsRegistered: false,
  }))

  export function register(provider: Provider): void {
    const instanceState = runtimeState()

    if (instanceState.providers.some((candidate) => candidate.id === provider.id)) return
    instanceState.providers.push(provider)
  }

  export function reset(): void {
    const instanceState = runtimeState()

    instanceState.providers.length = 0
    instanceState.builtinsRegistered = false
  }

  export async function list(sessionID: string): Promise<Info[]> {
    const instanceState = runtimeState()

    registerBuiltins()
    const batches = await Promise.all(
      instanceState.providers.map((provider) =>
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
    const instanceState = runtimeState()

    if (instanceState.builtinsRegistered) return
    instanceState.builtinsRegistered = true
    register({
      id: "cortex",
      async list(sessionID) {
        const active = await SessionCortexRuntime.activeTaskRows(sessionID)
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
