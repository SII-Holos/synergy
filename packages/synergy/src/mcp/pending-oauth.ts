import { Log } from "../util/log"

export namespace PendingOAuth {
  const log = Log.create({ service: "mcp.pending-oauth" })
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

  export interface ClientOwner {
    close(): Promise<void>
  }

  export interface AuthTransport {
    finishAuth(authorizationCode: string): Promise<void>
  }

  export interface Connection {
    client: ClientOwner
    transport: AuthTransport
    onDispose?: () => void | Promise<void>
  }

  interface Entry extends Connection {
    timeout: ReturnType<typeof setTimeout>
  }

  const entries = new Map<string, Entry>()

  export async function register(
    name: string,
    connection: Connection,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    await dispose(name, "replaced")
    const timeout = setTimeout(() => {
      void dispose(name, "expired")
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref()
    entries.set(name, { ...connection, timeout })
  }

  export function get(name: string): Connection | undefined {
    return entries.get(name)
  }

  export async function dispose(name: string, reason: string): Promise<void> {
    const entry = entries.get(name)
    if (!entry) return
    entries.delete(name)
    clearTimeout(entry.timeout)
    await Promise.all([
      entry.client.close().catch((error) => {
        log.warn("failed to close pending OAuth client", { name, reason, error })
      }),
      Promise.resolve(entry.onDispose?.()).catch((error) => {
        log.warn("failed to clean pending OAuth state", { name, reason, error })
      }),
    ])
  }

  export async function disposeAll(reason: string): Promise<void> {
    await Promise.all([...entries.keys()].map((name) => dispose(name, reason)))
  }
}
