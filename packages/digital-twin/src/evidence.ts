import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionCorpus } from "@ericsanchezok/synergy-harness/session/corpus"
import { SessionSearchIndex } from "@ericsanchezok/synergy-harness/session/search-index"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"
import { SecretMask } from "@ericsanchezok/synergy-harness/secrets/mask"

export function normalize(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, "")
}

export function original(message: { info: MessageV2.Info; parts: MessageV2.Part[] }): string | undefined {
  const canonical = MessageV2.deriveSemantics([message])[0]!
  const info = canonical.info
  if (
    info.role !== "user" ||
    !MessageV2.isHumanInput(info) ||
    info.visible === false ||
    info.includeInContext === false
  )
    return
  const metadata = info.metadata ?? {}
  if (InputAssistance.read(metadata) || metadata.assistance !== undefined) return
  if (
    ["author", "sender", "speaker", "channel", "channelPush", "mailbox", "generated", "pasted"].some(
      (key) => metadata[key] !== undefined,
    )
  )
    return
  if (metadata.source !== undefined && metadata.source !== "user") return
  const parts = canonical.parts.filter(
    (part): part is MessageV2.TextPart => part.type === "text" && !MessageV2.isSystemPart(part),
  )
  if (parts.some((part) => part.metadata?.source || part.metadata?.pasted || part.metadata?.generated)) return
  const text = parts
    .map((part) => part.text)
    .join("\n\n")
    .trim()
  if (!text || /⟦sec:|```|^\s*(?:>|#{1,6}\s|<\/?[a-z][^>]*>)/im.test(text)) return
  return text
}

export function sketch(texts: string[]) {
  return texts.reduce(
    (value, text) => ({
      count: value.count + 1,
      characters: value.characters + text.length,
      han: value.han + (text.match(/\p{Script=Han}/gu)?.length ?? 0),
      latin: value.latin + (text.match(/[A-Za-z]+/g)?.length ?? 0),
      questions: value.questions + (text.match(/[?？]/g)?.length ?? 0),
      commas: value.commas + (text.match(/[,，]/g)?.length ?? 0),
      newlines: value.newlines + (text.match(/\n/g)?.length ?? 0),
      lengths: value.lengths.map(
        (count, index) => count + (Math.min(4, Math.floor(Math.log2(Math.max(1, text.length)) / 2)) === index ? 1 : 0),
      ),
    }),
    { count: 0, characters: 0, han: 0, latin: 0, questions: 0, commas: 0, newlines: 0, lengths: [0, 0, 0, 0, 0] },
  )
}
export type Sketch = ReturnType<typeof sketch>

export function diversify<T extends { text: string; family: string; score: number }>(
  items: T[],
  limit: number,
  perFamily = 2,
) {
  const seen = new Set<string>()
  const families = new Map<string, number>()
  return items
    .toSorted((a, b) => b.score - a.score)
    .filter((item) => {
      const key = normalize(item.text)
      if (!key || seen.has(key) || (families.get(item.family) ?? 0) >= perFamily) return false
      seen.add(key)
      families.set(item.family, (families.get(item.family) ?? 0) + 1)
      return true
    })
    .slice(0, limit)
}

export interface Evidence {
  id: string
  kind: "voice" | "continuation"
  text: string
  previous?: string
  family: string
  score: number
  references: SessionCorpus.Reference[]
}

export async function collect(input: {
  current: string
  representatives: SessionCorpus.Reference[]
  sessionID: string
  signal?: AbortSignal
}) {
  const tokens = [...new Set(SessionSearchIndex.tokenize(input.current))]
  const terms = tokens.slice(-32)
  const hits: Awaited<ReturnType<typeof SessionCorpus.query>>["items"] = []
  let cursor: string | undefined
  for (let page = 0; terms.length && page < 4; page++) {
    input.signal?.throwIfAborted()
    const result = await SessionCorpus.query({
      terms,
      cursor,
      roles: ["user", "assistant"],
      limit: 24,
      signal: input.signal,
    })
    hits.push(...result.items)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  const references = [...hits.map((hit) => hit.reference), ...input.representatives]
  const seen = new Set<string>()
  const evidence: Evidence[] = []
  for (const reference of references) {
    input.signal?.throwIfAborted()
    const key = `${reference.scopeID}/${reference.sessionID}/${reference.messageID}`
    if (seen.has(key) || reference.sessionID === input.sessionID) continue
    seen.add(key)
    const neighborhood = await SessionCorpus.neighborhood(reference)
    if (!neighborhood) continue
    const user = neighborhood.message.info.role === "user" ? neighborhood.message : neighborhood.next
    if (!user) continue
    const text = original(user)
    if (!text || (await SecretMask.apply(text)) !== text) continue
    const previous = neighborhood.message.info.role === "assistant" ? neighborhood.message : neighborhood.previous
    const age = Math.max(0, Date.now() - user.info.time.created) / 86_400_000
    const score = SessionSearchIndex.overlapScore(`${previous?.text ?? ""}\n${text}`, tokens) + 1 / (1 + age / 30)
    const voice: Evidence = {
      id: key,
      kind: "voice",
      text,
      family: user.reference.family,
      score,
      references: [user.reference],
    }
    evidence.push(voice)
    if (
      previous?.text &&
      previous.info.role === "assistant" &&
      !previous.info.error &&
      !previous.info.summary &&
      previous.info.finish &&
      !["tool-calls", "unknown"].includes(previous.info.finish)
    ) {
      const preceding = await SecretMask.apply(previous.text)
      evidence.push({
        ...voice,
        id: `${key}/continuation`,
        kind: "continuation",
        previous: preceding,
        references: [previous.reference, user.reference],
      })
    }
  }
  return [
    ...diversify(
      evidence.filter((item) => item.kind === "continuation"),
      12,
    ),
    ...diversify(
      evidence.filter((item) => item.kind === "voice"),
      16,
    ),
  ]
}
