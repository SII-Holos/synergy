import { RuntimeContext } from "../lifecycle/context"

export namespace AttachmentImageInput {
  // Provenance: https://github.com/openai/codex/blob/cc7ba33601286a751477832b01de7b6f8de0dd9c/codex-rs/utils/image/src/lib.rs
  // Local adaptation: one high-detail budget across providers, with additional byte and decoder limits; originals remain Assets.
  export const BUDGET = Object.freeze({
    maxDimension: 2048,
    patchSize: 32,
    maxPatches: 2500,
    maxBytes: 4 * 1024 * 1024,
    maxInputBytes: 64 * 1024 * 1024,
    maxInputPixels: 100_000_000,
  })

  export type Result =
    | {
        ok: true
        data: string
        mediaType: string
        width: number
        height: number
        originalWidth: number
        originalHeight: number
      }
    | { ok: false; reason: "unavailable" | "invalid" | "too-large" }

  export type Processor = (bytes: Uint8Array, signal: AbortSignal) => Promise<Result>
  const state = RuntimeContext.state(() => ({ processor: undefined as Processor | undefined }))

  export function register(processor: Processor) {
    RuntimeContext.assertCompositionOpen("attachment/image-input")
    if (state().processor) throw new Error("Image input processing is already registered")
    state().processor = processor
  }

  export async function prepare(bytes: Uint8Array, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted()
    if (bytes.byteLength > BUDGET.maxInputBytes) return { ok: false, reason: "too-large" }
    if (!bytes.byteLength) return { ok: false, reason: "invalid" }
    const processor = state().processor
    if (!processor) return { ok: false, reason: "unavailable" }
    const result = await processor(bytes, signal)
    signal.throwIfAborted()
    return result
  }
}
