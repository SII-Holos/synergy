/**
 * Cumulative generated-word proxy for reasoning text already hydrated in the browser.
 *
 * Segmentation follows the active locale, so the value approximates reading progress
 * rather than any provider token count. Each text is segmented independently and the
 * counts are summed in canonical Part order; the source text is never transformed.
 */
export function countReasoningWords(texts: readonly string[], locale: string): number {
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" })
  let total = 0
  for (const text of texts) {
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) total++
  }
  return total
}
