import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { UpgradeWork } from "../storage/upgrade-work"
import { LEXICAL_VERSION, TEXT_FRAGMENT_CHARS, TEXT_QUERY_CHARS, type TextCategory } from "../storage/text-projection"
import { MessageV2 } from "./message-v2"
import { PartContent } from "./part-content"
import { Log } from "../util/log"
import { Identifier } from "../id/id"

export namespace SessionHistorySearch {
  interface State {
    version: 2
    encoding?: "hex" | "bytes"
    phase: "scan" | "dirty"
    cursor?: string[]
    current?: string[]
    ready: boolean
    prepared: number
  }
  const initial: State = { version: 2, phase: "scan", ready: false, prepared: 0 }
  const batches = Storage.state(() => new Map<string, Promise<{ ready: boolean; prepared: number }>>())
  const background = Storage.state(() => ({
    pending: new Map<string, { scopeID: string; sessionID: string }>(),
    stopping: false,
    task: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    controller: undefined as ReturnType<typeof UpgradeWork.controller> | undefined,
  }))

  export function requestBackground(scopeID: string, sessionID: string) {
    const state = background()
    if (state.stopping) return
    const identity = `${scopeID}/${sessionID}`
    state.pending.delete(identity)
    state.pending.set(identity, { scopeID, sessionID })
    const pump = () => {
      if (state.stopping || state.task) return
      clearTimeout(state.timer)
      state.task = (async () => {
        while (!state.stopping && state.pending.size) {
          const [key, owner] = [...state.pending].at(-1)!
          state.controller = UpgradeWork.controller(false, owner.sessionID)
          try {
            const status = await prepareBatch(owner.scopeID, owner.sessionID, state.controller.controller.signal)
            if (status.ready) state.pending.delete(key)
          } catch (error) {
            if (!state.controller.controller.signal.aborted) {
              Log.create({ service: "session-history-search" }).warn("History search preparation deferred", { error })
            }
            break
          } finally {
            state.controller.dispose()
            state.controller = undefined
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      })().finally(() => {
        state.task = undefined
        if (!state.stopping && state.pending.size) {
          state.timer = setTimeout(pump, 500)
          state.timer.unref()
        }
      })
    }
    if (!state.task && !state.timer) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        pump()
      }, 0)
      state.timer.unref()
    }
  }

  export async function stop() {
    const state = background()
    state.stopping = true
    clearTimeout(state.timer)
    state.pending.clear()
    state.controller?.controller.abort(new DOMException("History search preparation is closing", "AbortError"))
    await state.task
    await Promise.allSettled(batches().values())
  }

  export async function initialize(scopeID: string, sessionID: string) {
    const key = StoragePath.sessionTextState(scopeID, sessionID)
    const [state] = await Storage.readMany<State>([key])
    if (!state || state.version !== initial.version)
      await Storage.write(key, { ...initial, encoding: Storage.current().store.keyEncodedAs })
  }

  export async function partWritten(scopeID: string, part: Pick<MessageV2.Part, "sessionID" | "messageID" | "id">) {
    await Storage.write(StoragePath.sessionTextDirty(scopeID, part.sessionID, part.messageID, part.id), {
      key: StoragePath.messagePart(
        Identifier.asScopeID(scopeID),
        Identifier.asSessionID(part.sessionID),
        Identifier.asMessageID(part.messageID),
        Identifier.asPartID(part.id),
      ),
    })
    const key = StoragePath.sessionTextState(scopeID, part.sessionID)
    const [state] = await Storage.readMany<State>([key])
    if (state?.ready) await Storage.write(key, { ...state, ready: false })
  }

  function content(part: MessageV2.Part): { category: TextCategory; text: string } {
    if (MessageV2.isSystemPart(part)) return { category: "text", text: "" }
    if (part.type === "text" || part.type === "reasoning") return { category: part.type, text: part.text }
    if (part.type !== "tool") return { category: "text", text: "" }
    const output =
      part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : ""
    return { category: "tool", text: [JSON.stringify(part.state.input), output].filter(Boolean).join("\n\n") }
  }

  export async function preparePart(key: string[], signal?: AbortSignal) {
    signal?.throwIfAborted()
    const source = await Storage.snapshot(async (tx) => {
      const [revision] = await tx.revisions([key])
      if (revision === undefined) return undefined
      const projection = await tx.textProjectionState(key)
      if (
        projection?.revision === revision &&
        projection.ready &&
        projection.lexical?.version === LEXICAL_VERSION &&
        projection.lexical.ready
      )
        return { ready: true as const }
      const record = await tx.versioned<PartContent.Stored>(key)
      return {
        ready: false as const,
        record,
        projection,
        version: PartContent.summary(record.value).content.version,
        part: await PartContent.hydrate(key, record.value),
      }
    })
    if (!source || source.ready) return true
    const version = source.version
    const prepared =
      source.projection?.revision === source.record.revision &&
      source.projection.version === version &&
      source.projection.lexical?.version === LEXICAL_VERSION
    const offset = prepared ? source.projection!.lexical!.progress : 0
    const body = content(source.part)
    const count = Math.ceil(body.text.length / TEXT_FRAGMENT_CHARS)
    const fragments = Array.from({ length: Math.min(4, Math.max(0, count - offset)) }, (_, index) => {
      const start = (offset + index) * TEXT_FRAGMENT_CHARS
      return { offset: start, text: body.text.slice(start, start + TEXT_FRAGMENT_CHARS + TEXT_QUERY_CHARS * 2) }
    })
    const complete = offset + fragments.length >= count
    signal?.throwIfAborted()
    return Storage.transaction(async (tx) => {
      const accepted = await tx.appendTextProjection({
        key,
        revision: source.record.revision,
        version,
        category: body.category,
        offset,
        fragments,
        complete,
      })
      return accepted && complete
    })
  }

  export function prepareBatch(scopeID: string, sessionID: string, signal?: AbortSignal) {
    const identity = `${scopeID}/${sessionID}`
    const pending = batches().get(identity)
    if (pending) return pending
    const task = UpgradeWork.run({ background: false, sessionID, signal }, async () => {
      await UpgradeWork.checkpoint()
      const stateKey = StoragePath.sessionTextState(scopeID, sessionID)
      const source = await Storage.snapshot(async (tx) => {
        const [stored] = await tx.readMany<State>([stateKey])
        const encoding = Storage.current().store.keyEncodedAs
        const state: State =
          stored?.version === initial.version && stored.encoding === encoding ? stored : { ...initial, encoding }
        if (state.ready) return { state }
        const marker =
          state.phase === "dirty"
            ? (await tx.query<{ key: string[] }>({ kind: "text_dirty", scopeID, sessionID, limit: 1 }))[0]
            : undefined
        const key =
          state.current ??
          (state.phase === "scan"
            ? (await tx.queryKeys({ kind: "part", scopeID, sessionID, after: state.cursor, limit: 1 }))[0]
            : marker?.value.key)
        if (!key) return { state }
        return { state, key, marker }
      })
      if (source.state.ready) return { ready: true, prepared: source.state.prepared }
      if (!source.key) {
        const state: State = {
          ...source.state,
          phase: "dirty",
          ready: source.state.phase === "dirty",
          current: undefined,
        }
        await Storage.transaction(async (tx) => {
          if (state.ready && (await tx.queryKeys({ kind: "text_dirty", scopeID, sessionID, limit: 1 })).length)
            state.ready = false
          await tx.write(stateKey, state)
        })
        return { ready: state.ready, prepared: state.prepared }
      }
      const complete = await preparePart(source.key, signal)
      await UpgradeWork.checkpoint()
      const updated = await Storage.transaction(async (tx) => {
        if (complete && source.marker) {
          const current = await tx.versioned(source.marker.key).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (current?.revision === source.marker.revision) await tx.remove(source.marker.key)
        }
        await tx.write(stateKey, {
          ...source.state,
          current: complete ? undefined : source.key,
          cursor: complete && source.state.phase === "scan" ? source.key : source.state.cursor,
          prepared: source.state.prepared + Number(complete && source.state.phase === "scan"),
          ready: false,
        } satisfies State)
        return true
      })
      return {
        ready: false,
        prepared: source.state.prepared + Number(updated && complete && source.state.phase === "scan"),
      }
    })
    batches().set(identity, task)
    void task
      .finally(() => {
        if (batches().get(identity) === task) batches().delete(identity)
      })
      .catch(() => {})
    return task
  }
}
