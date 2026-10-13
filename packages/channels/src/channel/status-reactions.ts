import { Log } from "@ericsanchezok/synergy-harness/util/log"

const log = Log.create({ service: "channel.status-reactions" })

export type StatusReactionAdapter = {
  setReaction: (emoji: string) => Promise<string | void>
  removeReaction?: (reactionId: string) => Promise<void>
}

export type StatusReactionEmojis = {
  queued: string
  tool: string
  done: string
  error: string
}

export type StatusReactionOutcome = { delivered: boolean; error?: unknown }

export type StatusReactionController = {
  setQueued: () => Promise<void>
  setTool: (toolName?: string) => Promise<void>
  setDone: () => Promise<void>
  setError: () => Promise<void>
  /**
   * Finish the turn with a caller-supplied emoji instead of the configured
   * done emoji, reporting whether it was actually written. Reaction-only
   * delivery uses this so the message ends with the single reaction the user
   * asked for: a plain `setDone()` alongside it would stack two reactions on
   * the same inbound message. The outcome is what lets the caller mark the
   * turn delivered only on a real success.
   */
  setFinishedWith: (emoji: string) => Promise<StatusReactionOutcome>
}

export const FEISHU_DEFAULT_STATUS_REACTION_EMOJIS: StatusReactionEmojis = {
  queued: "Typing",
  tool: "Typing",
  done: "DONE",
  error: "ERROR",
}

export function createStatusReactionController(params: {
  adapter: StatusReactionAdapter
  emojis?: Partial<StatusReactionEmojis>
  onError?: (error: unknown) => void
}): StatusReactionController {
  const adapter = params.adapter
  const emojis = { ...FEISHU_DEFAULT_STATUS_REACTION_EMOJIS, ...params.emojis }

  let currentEmoji = ""
  let currentReactionId = ""
  let finished = false
  let chain = Promise.resolve()

  function handleError(error: unknown) {
    if (params.onError) {
      params.onError(error)
      return
    }
    log.warn("status reaction update failed", { error })
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = chain.then(fn, fn)
    chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async function applyEmoji(emoji: string): Promise<void> {
    if (!emoji || currentEmoji === emoji) return

    const previousReactionId = currentReactionId
    const previousEmoji = currentEmoji
    const reactionId = await adapter.setReaction(emoji)

    currentEmoji = emoji
    currentReactionId = reactionId ?? ""

    if (!adapter.removeReaction || !previousReactionId || previousEmoji === emoji) return

    try {
      await adapter.removeReaction(previousReactionId)
    } catch (error) {
      handleError(error)
    }
  }

  function setIntermediate(emoji: string): Promise<void> {
    if (finished) return Promise.resolve()
    return enqueue(() => applyEmoji(emoji)).catch((error) => {
      handleError(error)
    })
  }

  function setTerminal(emoji: string): Promise<void> {
    finished = true
    return enqueue(() => applyEmoji(emoji)).catch((error) => {
      handleError(error)
    })
  }

  /**
   * `applyEmoji` treats an already-current emoji as a no-op success, which is
   * the correct reading here: the desired reaction is on the message. Only a
   * throw from `setReaction` counts as a failure to deliver.
   */
  async function finishWith(emoji: string): Promise<StatusReactionOutcome> {
    finished = true
    try {
      await enqueue(() => applyEmoji(emoji.trim() || emojis.done))
      return { delivered: true }
    } catch (error) {
      handleError(error)
      return { delivered: false, error }
    }
  }

  return {
    setQueued: () => setIntermediate(emojis.queued),
    setTool: (_toolName?: string) => setIntermediate(emojis.tool),
    setDone: () => setTerminal(emojis.done),
    setError: () => setTerminal(emojis.error),
    setFinishedWith: finishWith,
  }
}
