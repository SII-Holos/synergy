import type { Tiktoken } from "js-tiktoken"

type EncodingName = "o200k_base" | "cl100k_base"

export namespace Token {
  const CHARS_PER_TOKEN = 4

  /**
   * Fast heuristic token estimate. Used as the universal fallback when an
   * accurate tokenizer is unavailable (non-OpenAI models, init failure, etc.).
   */
  export function estimate(input: string) {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
  }

  /** Conservative token estimate for any serializable value. */
  export function estimateJSON(value: unknown): number {
    if (typeof value === "string") return estimate(value)
    try {
      return estimate(JSON.stringify(value))
    } catch {
      return 0
    }
  }

  // ---------------------------------------------------------------------------
  // Model-aware tokenization via js-tiktoken
  // ---------------------------------------------------------------------------

  const encoderCache = new Map<EncodingName, Tiktoken>()

  /**
   * Lazily initialize and cache a Tiktoken encoder for the given encoding.
   * Returns `undefined` if the encoding data fails to load (prevents one-time
   * import errors from poisoning every subsequent call).
   */
  async function getTokenizer(encoding: EncodingName): Promise<Tiktoken | undefined> {
    const cached = encoderCache.get(encoding)
    if (cached) return cached

    try {
      // Dynamic import so the ~2MB BPE rank files are loaded only when needed
      // and only for encodings actually used at runtime.
      const { getEncoding } = await import("js-tiktoken")
      const enc = getEncoding(encoding)
      encoderCache.set(encoding, enc)
      return enc
    } catch {
      return undefined
    }
  }

  /**
   * Map a model ID (as seen in Provider.Model.id) to a tiktoken encoding.
   * Returns `undefined` for non-OpenAI models where no public BPE vocabulary
   * exists, signaling the caller to fall back to the heuristic estimator.
   *
   * Encoding assignments:
   *   o200k_base  – GPT-4o, GPT-4.1, GPT-4.5, GPT-5, o1, o3, o4, chatgpt-4o-latest
   *   cl100k_base – GPT-4, GPT-4-turbo, GPT-3.5-turbo, text-embedding-3-*
   */
  export function encodingForModelID(modelID: string): EncodingName | undefined {
    const id = modelID.toLowerCase()

    // Non-OpenAI providers — no public tokenizer
    if (
      id.includes("claude") ||
      id.includes("gemini") ||
      id.includes("qwen") ||
      id.includes("deepseek") ||
      id.includes("glm") ||
      id.includes("minimax") ||
      id.includes("kimi") ||
      id.includes("mistral") ||
      id.includes("llama") ||
      id.includes("yi-") ||
      id.includes("command")
    )
      return undefined

    // o200k_base family (newest OpenAI models)
    if (
      id.includes("gpt-4o") ||
      id.includes("gpt-4.1") ||
      id.includes("gpt-4.5") ||
      id.startsWith("gpt-5") ||
      id.startsWith("o1") ||
      id.startsWith("o3") ||
      id.startsWith("o4") ||
      id.includes("chatgpt-4o")
    )
      return "o200k_base"

    // cl100k_base family
    if (
      id.startsWith("gpt-4") ||
      id.startsWith("gpt-3.5") ||
      id.includes("text-embedding-3") ||
      id.includes("text-embedding-ada")
    )
      return "cl100k_base"

    // Unknown OpenAI-ish model — use o200k_base as the most likely encoding
    // for any future OpenAI model not yet in our list.
    if (id.includes("gpt") || id.startsWith("o")) return "o200k_base"

    return undefined
  }

  /**
   * Count tokens using a model-specific tokenizer when available,
   * falling back to the `chars / 4` heuristic for unsupported models.
   *
   * This is async because the first call for a given encoding lazily imports
   * the BPE rank data (~2MB per encoding). Subsequent calls for the same
   * encoding are synchronous cache hits and complete in microseconds.
   */
  export async function estimateModel(modelID: string, input: string): Promise<number> {
    if (!input) return 0
    const encoding = encodingForModelID(modelID)
    if (!encoding) return estimate(input)
    const tokenizer = await getTokenizer(encoding)
    if (!tokenizer) return estimate(input)
    try {
      return tokenizer.encode(input).length
    } catch {
      return estimate(input)
    }
  }

  /**
   * Synchronous model-aware token count. Returns the accurate count if the
   * tokenizer for this model's encoding has already been initialized, otherwise
   * falls back to the heuristic. Use this in hot paths where `await` is
   * undesirable (e.g. inside tight estimation loops).
   */
  export function estimateModelSync(modelID: string, input: string): number {
    if (!input) return 0
    const encoding = encodingForModelID(modelID)
    if (!encoding) return estimate(input)
    const tokenizer = encoderCache.get(encoding)
    if (!tokenizer) return estimate(input)
    try {
      return tokenizer.encode(input).length
    } catch {
      return estimate(input)
    }
  }

  /**
   * Eagerly warm the tokenizer cache for a model's encoding. Call this early
   * in a session lifecycle so that subsequent `estimateModelSync` calls can
   * use the accurate tokenizer instead of the heuristic fallback.
   */
  export async function warmup(modelID: string): Promise<void> {
    const encoding = encodingForModelID(modelID)
    if (encoding) await getTokenizer(encoding)
  }
}
