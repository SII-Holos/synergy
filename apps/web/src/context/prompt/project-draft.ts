import type { ContentPart, Prompt, PromptContextSnapshot } from "."

export type ProjectDraft = { prompt: Prompt; context: PromptContextSnapshot }

export function qualifyProjectDraft(draft: ProjectDraft, scopeID: string, directory?: string): ProjectDraft {
  const qualify = <T extends { path: string; originScopeID?: string }>(item: T): T => {
    if (item.originScopeID || /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(item.path)) return { ...item }
    return directory
      ? { ...item, path: `${directory.replace(/[\\/]$/, "")}/${item.path}` }
      : { ...item, originScopeID: scopeID }
  }
  return {
    prompt: draft.prompt.map((part) => (part.type === "file" ? qualify(part) : { ...part })),
    context: { items: draft.context.items.map(qualify) },
  }
}

export function mergeProjectDrafts(target: ProjectDraft, source: ProjectDraft): ProjectDraft {
  const key = (part: ContentPart) =>
    part.type === "attachment"
      ? `attachment:${part.url}`
      : part.type === "note"
        ? `note:${part.noteId}`
        : part.type === "session"
          ? `session:${part.scopeID}:${part.sessionId}`
          : undefined
  const prompt: Prompt = []
  const seen = new Set<string>()
  let offset = 0
  const add = (parts: Prompt) => {
    for (const part of parts) {
      const identity = key(part)
      if (identity && seen.has(identity)) continue
      if (identity) seen.add(identity)
      if ("content" in part && (part.type === "text" || part.type === "file")) {
        if (!part.content) continue
        prompt.push({ ...part, start: offset, end: offset + part.content.length })
        offset += part.content.length
      } else prompt.push({ ...part })
    }
  }
  add(target.prompt)
  if (offset && source.prompt.some((part) => (part.type === "text" || part.type === "file") && part.content))
    add([{ type: "text", content: "\n\n", start: 0, end: 2 }])
  add(source.prompt)
  const items = new Map<string, PromptContextSnapshot["items"][number]>()
  for (const item of [...target.context.items, ...source.context.items])
    items.set(JSON.stringify([item.originScopeID, item.path, item.selection]), { ...item })
  return {
    prompt: prompt.length ? prompt : [{ type: "text", content: "", start: 0, end: 0 }],
    context: { items: [...items.values()] },
  }
}
