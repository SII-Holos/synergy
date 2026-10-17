import type { BrowserHostMessage } from "@ericsanchezok/synergy-browser-core"

type Context = Pick<
  Extract<BrowserHostMessage, { type: "profile.data.prepare" }>,
  "contextId" | "epoch" | "ownerKey" | "profile" | "expiresAt"
>
export type BrowserProfileDataTarget = {
  partition: string
  session: Electron.Session
  current(): boolean
  signal: AbortSignal
  write<T>(operation: () => Promise<T>): Promise<T>
}

export class BrowserDataContexts {
  private contexts = new Map<string, Context & { abort: AbortController; timer: ReturnType<typeof setTimeout> }>()
  private tails = new Map<string, Promise<unknown>>()
  private epoch: string | undefined

  constructor(private options: { session(partition: string): Electron.Session }) {}

  prepare(input: Context): void {
    if (!/^persist:synergy-browser-[a-zA-Z0-9._-]+$/.test(input.profile.partition))
      throw new Error("Choose an enabled persistent browser profile.")
    if (this.epoch && this.epoch !== input.epoch) this.disconnect()
    if (this.contexts.has(input.contextId)) throw new Error("Browser data context already exists.")
    if (input.expiresAt <= Date.now()) throw new Error("Browser data access expired. Reopen this dialog.")
    this.epoch = input.epoch
    const timer = setTimeout(() => this.close(input.contextId), input.expiresAt - Date.now())
    timer.unref()
    this.contexts.set(input.contextId, { ...input, abort: new AbortController(), timer })
  }

  target(contextId: string): BrowserProfileDataTarget {
    const context = this.contexts.get(contextId)
    if (!context || context.epoch !== this.epoch || context.expiresAt <= Date.now()) {
      this.close(contextId)
      throw new Error("Browser data access expired. Reopen this dialog.")
    }
    const current = () =>
      this.contexts.get(contextId) === context &&
      context.epoch === this.epoch &&
      context.expiresAt > Date.now() &&
      !context.abort.signal.aborted
    return {
      partition: context.profile.partition,
      session: this.options.session(context.profile.partition),
      current,
      signal: context.abort.signal,
      write: async <T>(operation: () => Promise<T>) => {
        const partition = context.profile.partition
        const pending = (this.tails.get(partition) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            if (!current()) throw new Error("Browser data access expired. Reopen this dialog.")
            return operation()
          })
        this.tails.set(partition, pending)
        try {
          return await pending
        } finally {
          if (this.tails.get(partition) === pending) this.tails.delete(partition)
        }
      },
    }
  }

  release(contextId: string, epoch: string, ownerKey: string): void {
    const context = this.contexts.get(contextId)
    if (!context || context.epoch !== epoch || context.ownerKey !== ownerKey) return
    this.contexts.delete(contextId)
    clearTimeout(context.timer)
    context.abort.abort()
  }

  revokeProfile(profileId: string): void {
    for (const context of this.contexts.values())
      if (context.profile.id === profileId) this.release(context.contextId, context.epoch, context.ownerKey)
  }

  close(contextId: string): void {
    const context = this.contexts.get(contextId)
    if (context) this.release(contextId, context.epoch, context.ownerKey)
  }

  async drain(partition: string): Promise<void> {
    await this.tails.get(partition)?.catch(() => undefined)
  }

  disconnect(): void {
    for (const id of this.contexts.keys()) this.close(id)
    this.contexts.clear()
    this.epoch = undefined
  }
}
