import type { useSDK } from "./sdk"

export async function resolveNoteReference(
  client: ReturnType<typeof useSDK>["client"],
  scopeID: string | undefined,
  id: string,
  signal?: AbortSignal,
): Promise<{ id: string; scopeID: string }> {
  signal?.throwIfAborted()
  const groups = await Promise.all(
    (["false", "true"] as const).map(async (archived) => {
      const result = await client.note.listMeta({ scopeID, archived }, { signal, throwOnError: true })
      return result.data ?? []
    }),
  )
  signal?.throwIfAborted()
  const scopes = new Set(
    groups
      .flat()
      .filter((group) => group.notes.some((note) => note.id === id))
      .map((group) => group.scopeID),
  )
  if (!scopes.size) throw new Error("Note reference not found.")
  if (scopes.size !== 1) throw new Error("Note reference matches multiple Scopes.")
  return { id, scopeID: [...scopes][0]! }
}

type NoteNode = { type: string; attrs?: Record<string, unknown>; content?: unknown[]; text?: string }

function noteNode(value: unknown): value is NoteNode {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return false
  if ("content" in value && value.content !== undefined && !Array.isArray(value.content)) return false
  if (
    "attrs" in value &&
    value.attrs !== undefined &&
    (!value.attrs || typeof value.attrs !== "object" || Array.isArray(value.attrs))
  )
    return false
  return true
}

function plainText(value: unknown): string {
  if (!noteNode(value)) return ""
  if (value.type === "text") return typeof value.text === "string" ? value.text : ""
  if (value.type === "hardBreak") return "\n"
  const attribute =
    value.type === "image" ? value.attrs?.alt : value.type === "inlineMath" ? value.attrs?.latex : undefined
  if (typeof attribute === "string") return attribute
  const inline = ["paragraph", "heading", "codeBlock"].includes(value.type)
  return (value.content ?? []).map(plainText).join(inline ? "" : "\n")
}

function findBlock(
  nodes: unknown[],
  blockId: string,
): { node: NoteNode; siblings: unknown[]; index: number } | undefined {
  for (const [index, node] of nodes.entries()) {
    if (!noteNode(node)) continue
    if (node.attrs?.blockId === blockId) return { node, siblings: nodes, index }
    const nested = findBlock(node.content ?? [], blockId)
    if (nested) return nested
  }
}

export function noteReferenceExcerpt(content: unknown, blockId?: string): { text: string; found: boolean } {
  if (!noteNode(content) || content.type !== "doc") return { text: "", found: false }
  let nodes = content.content ?? []
  if (blockId) {
    const target = findBlock(nodes, blockId)
    if (!target) return { text: "", found: false }
    nodes = [target.node]
    if (target.node.type === "heading") {
      for (const sibling of target.siblings.slice(target.index + 1)) {
        if (
          noteNode(sibling) &&
          sibling.type === "heading" &&
          Number(sibling.attrs?.level ?? 1) <= Number(target.node.attrs?.level ?? 1)
        )
          break
        nodes.push(sibling)
      }
    }
  }
  const text = nodes.map(plainText).join("\n").replace(/\s+/g, " ").trim()
  return { text: text.length > 480 ? `${text.slice(0, 480).trimEnd()}…` : text, found: true }
}
