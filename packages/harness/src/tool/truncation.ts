import path from "path"
import { Global } from "../global"
import { Identifier } from "../id/id"
import type { Agent } from "../agent/agent"
import { RuntimeContext } from "../lifecycle/context"

export namespace Truncate {
  export interface Persistence {
    save(id: string, text: string): Promise<{ reference: string; instructions: string }>
  }
  const state = RuntimeContext.state(() => ({ backend: undefined as Persistence | undefined }))
  export function registerStorage(backend: Persistence) {
    RuntimeContext.assertCompositionOpen("Tool output storage")
    if (state().backend) throw new Error("Tool output storage is already registered")
    state().backend = backend
  }
  export const MAX_LINES = 2000
  export const MAX_BYTES = 50 * 1024
  export function directory() {
    return Global.Path.toolOutput
  }

  export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

  export interface Options {
    maxLines?: number
    maxBytes?: number
    direction?: "head" | "tail"
  }

  export async function output(text: string, options: Options = {}, _agent?: Agent.Info): Promise<Result> {
    const maxLines = options.maxLines ?? MAX_LINES
    const maxBytes = options.maxBytes ?? MAX_BYTES
    const direction = options.direction ?? "head"
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")

    if (lines.length <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false }
    }

    const out: string[] = []
    let i = 0
    let bytes = 0
    let hitBytes = false

    if (direction === "head") {
      for (i = 0; i < lines.length && i < maxLines; i++) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.push(lines[i])
        bytes += size
      }
    } else {
      for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
        const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > maxBytes) {
          hitBytes = true
          break
        }
        out.unshift(lines[i])
        bytes += size
      }
    }

    const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
    const unit = hitBytes ? "bytes" : "lines"
    const preview = out.join("\n")

    const id = Identifier.ascending("tool")
    const backend = state().backend
    const saved = backend ? await backend.save(id, text) : undefined
    const filepath = saved?.reference ?? path.join(directory(), id)
    if (!saved) await Bun.write(Bun.file(filepath), text)

    const instructions =
      saved?.instructions ??
      "Search the saved output or read a targeted range with offset/limit. Delegate only when a separate analysis task would help."
    const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${filepath}\n${instructions}`

    const message =
      direction === "head"
        ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
        : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`

    return { content: message, truncated: true, outputPath: filepath }
  }
}
