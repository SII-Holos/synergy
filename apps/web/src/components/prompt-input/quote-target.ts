import type { QuoteAttachmentPart } from "@/context/prompt"

export type QuoteDraftInput = Omit<QuoteAttachmentPart, "type" | "id">

/** The mounted, editable Composer that can accept a quoted selection. */
export type QuoteTarget = {
  available(): boolean
  accept(input: QuoteDraftInput): void
}

const targets = new Set<QuoteTarget>()

export function registerQuoteTarget(target: QuoteTarget) {
  targets.add(target)
  return () => targets.delete(target)
}

/**
 * Retained session views keep inactive composers mounted but hidden, so the
 * target is resolved by availability rather than by registration order.
 */
export const quoteTarget = () => Array.from(targets).find((target) => target.available())
