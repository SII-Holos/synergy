export namespace TextSearch {
  export const fragmentCharacters = 8192
  export const queryCharacters = 512

  export function fragments(text: string) {
    return Array.from({ length: Math.ceil(text.length / fragmentCharacters) }, (_, index) => {
      const start = index * fragmentCharacters
      return text.slice(start, start + fragmentCharacters + queryCharacters * 2)
    })
  }

  export function ranked<T extends { identity: string; parts: string[] }>(items: T[], terms: string[], limit: number) {
    const query = new Set(terms.flatMap(tokenize))
    return items
      .map((item) => ({
        ...item,
        score: new Set(
          item.parts
            .flatMap(fragments)
            .flatMap(tokenize)
            .filter((token) => query.has(token)),
        ).size,
      }))
      .filter((item) => item.score > 0)
      .toSorted((a, b) => b.score - a.score || (a.identity < b.identity ? 1 : a.identity > b.identity ? -1 : 0))
      .slice(0, limit)
  }

  /**
   * Lightweight Unicode tokenizer shared by relevance scoring and index
   * consumers. ASCII identifiers/numbers become single tokens; CJK runs become
   * overlapping bigrams (single characters stay single tokens) so mixed zh/en
   * content participates in lexical scoring.
   */
  export function tokenize(text: string): string[] {
    const out: string[] = []
    const re = /[A-Za-z0-9_]+|[\u4e00-\u9fff]+/g
    for (const match of text.matchAll(re)) {
      const raw = match[0]
      if (/^[A-Za-z0-9_]+$/.test(raw)) {
        out.push(raw.toLowerCase())
        continue
      }
      if (raw.length === 1) {
        out.push(raw)
        continue
      }
      for (let i = 0; i + 1 < raw.length; i++) out.push(raw.slice(i, i + 2))
    }
    return out
  }
}
