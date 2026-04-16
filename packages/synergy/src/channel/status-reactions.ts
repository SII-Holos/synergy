import { Log } from "../util/log"

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

export type StatusReactionController = {
  setQueued: () => Promise<void>
  setTool: (toolName?: string) => Promise<void>
  setDone: () => Promise<void>
  setError: () => Promise<void>
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

  function enqueue(fn: () => Promise<void>) {
    chain = chain.then(fn, fn)
    return chain
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

  return {
    setQueued: () => setIntermediate(emojis.queued),
    setTool: (_toolName?: string) => setIntermediate(emojis.tool),
    setDone: () => setTerminal(emojis.done),
    setError: () => setTerminal(emojis.error),
  }
}
