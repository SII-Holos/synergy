// Composer intent layering (issue #318).
//
// The model/agent shown in the composer is resolved from three strictly-ordered
// layers, and the lower layers are NEVER written back into the upper one:
//
//   1. draft         — the user's explicit choice for this session visit (memory)
//   2. sessionDefault — server modelOverride, else the last root message's value
//   3. fallback       — agent default / global recent / provider default
//
// Because history (layer 2) is a read-only derivation, a late message load can
// never silently overwrite a choice the user already made in layer 1. This
// module holds the pure resolution logic so it can be unit-tested without the
// reactive store.

export type ModelKey = { providerID: string; modelID: string }

/** First candidate (in priority order) that passes validation. */
export function resolveModel(
  candidates: ReadonlyArray<ModelKey | undefined>,
  isValid: (model: ModelKey) => boolean,
): ModelKey | undefined {
  for (const candidate of candidates) {
    if (candidate && isValid(candidate)) return candidate
  }
  return undefined
}

/** First candidate name (in priority order) that is currently selectable. */
export function resolveAgent(
  candidates: ReadonlyArray<string | undefined>,
  isSelectable: (name: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (candidate && isSelectable(candidate)) return candidate
  }
  return undefined
}
/** Variant shown by the composer: session intent first, then configured defaults. */
export function resolveVariantDisplay(
  sessionVariant: string | undefined,
  agentDefaultVariant: string | undefined,
  roleDefaultVariant: string | undefined,
): string | undefined {
  return sessionVariant ?? agentDefaultVariant ?? roleDefaultVariant
}

type RootMessageLike = { role: string; isRoot?: boolean; model?: ModelKey; agent?: string; variant?: string }

function lastRootMessage<T extends RootMessageLike>(messages: readonly T[] | undefined): T | undefined {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === "user" && message.isRoot === true) return message
  }
  return undefined
}

/**
 * The session's default model: an explicit server-side modelOverride wins;
 * otherwise inherit the model of the last root user message. Returns undefined
 * when neither is present (the caller then falls back to agent/global default).
 */
export function sessionDefaultModel(
  modelOverride: ModelKey | undefined,
  messages: readonly RootMessageLike[] | undefined,
): ModelKey | undefined {
  if (modelOverride) return modelOverride
  return lastRootMessage(messages)?.model
}

/** The session's default agent: the agent of the last root user message. */
export function sessionDefaultAgent(messages: readonly RootMessageLike[] | undefined): string | undefined {
  return lastRootMessage(messages)?.agent
}

/** The session's default model variant, scoped to the current effective model. */
export function sessionDefaultVariant(
  model: ModelKey | undefined,
  messages: readonly RootMessageLike[] | undefined,
): string | undefined {
  if (!model) return undefined
  const message = lastRootMessage(messages)
  if (!message?.variant || !message.model) return undefined
  if (message.model.providerID !== model.providerID || message.model.modelID !== model.modelID) return undefined
  return message.variant
}
