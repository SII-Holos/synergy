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
    identity: string
    onDispose?: () => void | Promise<void>
  }

  interface Entry extends Connection {
    timeout: ReturnType<typeof setTimeout>
  }

  const entries = new Map<string, Entry>()
  const mutations = new Map<string, Promise<void>>()

  function serialize<T>(name: string, mutation: () => Promise<T>): Promise<T> {
    const previous = mutations.get(name) ?? Promise.resolve()
    const current = previous.then(mutation, mutation)
    const settled = current.then(
      () => undefined,
      () => undefined,
    )
    mutations.set(name, settled)
    void settled.finally(() => {
      if (mutations.get(name) === settled) mutations.delete(name)
    })
    return current
  }

  export function register(
    name: string,
    connection: Connection,
    options: { timeoutMs?: number; isCurrent?: () => boolean } = {},
  ): Promise<boolean> {
    return serialize(name, async () => {
      if (options.isCurrent && !options.isCurrent()) {
        await releaseConnection(name, connection, "stale")
        return false
      }
      await disposeEntry(name, "replaced")
      if (options.isCurrent && !options.isCurrent()) {
        await releaseConnection(name, connection, "stale")
        return false
      }

      const timeout = setTimeout(() => {
        void dispose(name, "expired")
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      if (typeof timeout === "object" && "unref" in timeout) timeout.unref()
      entries.set(name, { ...connection, timeout })
      return true
    })
  }

  export function get(name: string): Connection | undefined {
    return entries.get(name)
  }

  export function disposeIfIdentity(name: string, identity: string, reason: string): Promise<boolean> {
    return serialize(name, async () => {
      const entry = entries.get(name)
      if (entry?.identity !== identity) return false
      entries.delete(name)
      await release(name, entry, reason)
      return true
    })
  }

  export function dispose(name: string, reason: string): Promise<void> {
    return serialize(name, () => disposeEntry(name, reason))
  }

  export function disposeIfCurrent(name: string, connection: Connection, reason: string): Promise<boolean> {
    return serialize(name, async () => {
      const entry = entries.get(name)
      if (entry !== connection) return false
      entries.delete(name)
      await release(name, entry, reason)
      return true
    })
  }

  async function disposeEntry(name: string, reason: string): Promise<void> {
    const entry = entries.get(name)
    if (!entry) return
    entries.delete(name)
    await release(name, entry, reason)
  }

  async function releaseConnection(name: string, connection: Connection, reason: string): Promise<void> {
    await Promise.all([
      connection.client.close().catch((error) => {
        log.warn("failed to close pending OAuth client", { name, reason, error })
      }),
      Promise.resolve(connection.onDispose?.()).catch((error) => {
        log.warn("failed to clean pending OAuth state", { name, reason, error })
      }),
    ])
  }

  async function release(name: string, entry: Entry, reason: string): Promise<void> {
    clearTimeout(entry.timeout)
    await releaseConnection(name, entry, reason)
  }

  export async function disposeAll(reason: string): Promise<void> {
    await Promise.all([...entries.keys()].map((name) => dispose(name, reason)))
  }
}
