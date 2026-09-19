import { Log } from "../util/log"
import { SecretPatterns } from "./patterns"
import { SecretVault } from "./vault"

const log = Log.create({ service: "secrets.mask" })

export namespace SecretMask {
  const MASKABLE_KEYS = new Set(["text", "content", "output", "value", "reasoning", "error"])

  /** Stable token for a key id; plain text, survives every serialization. */
  export function token(id: string): string {
    return `⟦sec:${id}⟧`
  }

  function replaceAll(text: string, index: { id: string; value: string }[]): string {
    let result = text
    for (const { id, value } of index) {
      if (value.length < 8) continue
      if (!result.includes(value)) continue
      result = result.split(value).join(token(id))
    }
    return result
  }

  /**
   * Replace registered secret values with their stable tokens. Tokens are
   * id-derived so the transform is idempotent and value-consistent: the same
   * secret yields the same token everywhere, forever.
   */
  export async function apply(text: string): Promise<string> {
    if (!text) return text
    const index = await SecretVault.maskIndex()
    if (index.length === 0) return text
    return replaceAll(text, index)
  }

  /**
   * Register secret-shaped values found in free text (non-blocking: a failed
   * registration logs and continues), then mask every registered value.
   * Over-registration is harmless because the mask is value-preserving.
   */
  export async function captureAndApply(text: string, source: SecretVault.Source): Promise<string> {
    if (!text) return text
    for (const detection of SecretPatterns.detect(text)) {
      try {
        if (await SecretVault.has(SecretVault.idOf(detection.value))) continue
        await SecretVault.register(detection.value, source)
      } catch (error) {
        log.warn("heuristic secret registration failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return apply(text)
  }

  /**
   * Mask one persisted message part. Text parts are capture-and-masked at
   * user-message materialization so durable storage never holds the pasted
   * plaintext; every other part shape passes through untouched.
   */
  export async function maskPart<P extends { type: string; text?: unknown }>(part: P): Promise<P> {
    if (part.type !== "text" || typeof part.text !== "string" || !part.text) return part
    const masked = await captureAndApply(part.text, { kind: "heuristic", context: "user_message" })
    if (masked === part.text) return part
    return { ...part, text: masked }
  }

  /**
   * Safety net over the final provider payload: walks message text/content/
   * output fields plus the late-system strings that bypass message
   * projection. Mutates in place; the input arrays are per-turn projections.
   * Binary part fields (image data, file blobs) are never touched.
   */
  export async function maskMessages(messages: unknown[], lateSystem?: string[]): Promise<boolean> {
    const index = await SecretVault.maskIndex()
    if (index.length === 0) return false
    let changed = false
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === "string") {
          if (!MASKABLE_KEYS.has(key)) continue
          const next = replaceAll(value, index)
          if (next !== value) {
            ;(node as Record<string, unknown>)[key] = next
            changed = true
          }
        } else if (value && typeof value === "object") {
          visit(value)
        }
      }
    }
    for (const message of messages) visit(message)
    if (lateSystem) {
      for (let i = 0; i < lateSystem.length; i++) {
        const next = replaceAll(lateSystem[i], index)
        if (next !== lateSystem[i]) {
          lateSystem[i] = next
          changed = true
        }
      }
    }
    return changed
  }

  /**
   * Mask one settled tool result in place, BEFORE rollout capture and
   * durable persistence, so authorization artifacts and session records stay
   * plaintext-free. Tool output is also the heuristic capture surface: an
   * unregistered credential echoed by a command registers here first.
   */
  export async function transformResult(result: Record<string, any>): Promise<Record<string, any>> {
    if (!result || typeof result !== "object") return result
    if (typeof result.output === "string" && result.output) {
      result.output = await captureAndApply(result.output, { kind: "heuristic", context: "tool_output" })
    }
    if (typeof result.title === "string" && result.title) {
      result.title = await apply(result.title)
    }
    const content = result.content
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && typeof (item as any).text === "string") {
          ;(item as any).text = await captureAndApply((item as any).text, {
            kind: "heuristic",
            context: "tool_output",
          })
        }
      }
    }
    if (result.metadata && typeof result.metadata === "object") {
      await maskStringsDeep(result.metadata)
    }
    return result
  }

  async function maskStringsDeep(node: unknown): Promise<void> {
    const index = await SecretVault.maskIndex()
    if (index.length === 0) return
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string") {
          const next = replaceAll(item, index)
          if (next !== item) (value as Record<string, unknown>)[key] = next
        } else if (item && typeof item === "object") {
          visit(item)
        }
      }
    }
    visit(node)
  }

  export const test = {
    replaceAll,
    MASKABLE_KEYS,
  }
}
