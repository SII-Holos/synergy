import { Plugin } from "./index"
import { tool } from "./tool"

const MAX_NOTE_TAGS = 8
const AUTO_TAG = "reference-plugin"

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9:_-]/g, "")
}

function mergeTags(tags?: string[]) {
  const unique = new Set<string>()
  for (const tag of tags ?? []) {
    const normalized = normalizeTag(tag)
    if (normalized) unique.add(normalized)
    if (unique.size >= MAX_NOTE_TAGS) break
  }
  unique.add(AUTO_TAG)
  return Array.from(unique).slice(0, MAX_NOTE_TAGS)
}

function preview(text: string, limit = 160) {
  const singleLine = text.replace(/\s+/g, " ").trim()
  if (singleLine.length <= limit) return singleLine
  return `${singleLine.slice(0, limit - 1)}…`
}

export const ExamplePlugin: Plugin = async (ctx) => {
  const logger = ctx.$.env({ SYNERGY_LOG_LEVEL: "warn" })

  return {
    tool: {
      workspace_summary: tool({
        description: "Summarize the active Synergy plugin runtime context",
        args: {
          includeDirectorySample: tool.schema.boolean().optional().describe("Include a short directory listing sample"),
        },
        async execute(args, context) {
          const lines = [
            `scope: ${ctx.scope.type}:${ctx.scope.id}`,
            `directory: ${ctx.directory}`,
            `worktree: ${ctx.worktree}`,
            `server: ${ctx.serverUrl.toString()}`,
            `session: ${context.sessionID}`,
            `agent: ${context.agent}`,
          ]

          if (args.includeDirectorySample) {
            const result = await logger`ls`
            const sample = result
              .text()
              .split("\n")
              .map((line: string) => line.trim())
              .filter(Boolean)
              .slice(0, 10)
            if (sample.length > 0) {
              lines.push(`entries: ${sample.join(", ")}`)
            }
          }

          return lines.join("\n")
        },
      }),
    },
    async "session.turn.after"(input) {
      const status = input.error ? "error" : (input.finish ?? "unknown")
      const summary = {
        sessionID: input.sessionID,
        assistantMessageID: input.assistantMessageID,
        agent: input.assistant.agent,
        finish: status,
      }
      console.info("[example-plugin] session.turn.after", summary)
    },
    async "note.create.before"(_, output) {
      output.note.title = output.note.title.trim() || "Untitled note"
      output.note.tags = mergeTags(output.note.tags)
      if (!output.note.contentText?.trim()) {
        output.note.contentText = preview(output.note.title)
      }
    },
    async "engram.memory.search.after"(input, output) {
      output.results = output.results
        .slice()
        .sort((left, right) => right.similarity - left.similarity)
        .slice(0, input.topK)
    },
  }
}

export default ExamplePlugin
