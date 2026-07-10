import fs from "node:fs"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Node } from "web-tree-sitter"
import { NoteMarkdown, NoteStore } from "../../note"
import { BashVirtualPath } from "./virtual-path"

export namespace BashVirtualFile {
  export interface Reference {
    startIndex: number
    endIndex: number
    provider: BashVirtualPath.Provider
    id: string
  }

  export interface Materialization {
    command: string
    extraReadRoots: string[]
    cleanup(): void
  }

  interface Provider {
    extension: string
    read(scopeID: string, id: string): Promise<string>
  }

  const providers = {
    note: {
      extension: ".md",
      async read(scopeID, id) {
        const note = await NoteStore.getAny(scopeID, id)
        return NoteMarkdown.toMarkdown(note.content)
      },
    },
  } satisfies Record<BashVirtualPath.Provider, Provider>

  export function references(root: Node): Reference[] {
    const result: Reference[] = []
    for (const node of root.descendantsOfType(["word", "string", "raw_string"])) {
      if (!node) continue
      const parsed = parseCandidate(node.type, node.text)
      if (!parsed) continue
      result.push({
        startIndex: node.startIndex + parsed.startOffset,
        endIndex: node.startIndex + parsed.endOffset,
        provider: parsed.provider,
        id: parsed.id,
      })
    }
    return result
  }

  export async function materialize(input: {
    command: string
    references: Reference[]
    scopeID: string
    tempRoot?: string
  }): Promise<Materialization> {
    if (input.references.length === 0) {
      return { command: input.command, extraReadRoots: [], cleanup() {} }
    }

    const tempDir = await mkdtemp(path.join(input.tempRoot ?? os.tmpdir(), "synergy-bash-files-"))
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {}
    }

    try {
      await chmod(tempDir, 0o700)
      const unique = new Map<string, Reference>()
      for (const reference of input.references) {
        unique.set(`${reference.provider}:${reference.id}`, reference)
      }

      const paths = new Map<string, string>()
      let index = 0
      for (const [key, reference] of unique.entries()) {
        const provider = providers[reference.provider]
        const content = await provider.read(input.scopeID, reference.id)
        const filepath = path.join(tempDir, `${index++}${provider.extension}`)
        await writeFile(filepath, content, { encoding: "utf-8", flag: "wx", mode: 0o600 })
        await chmod(filepath, 0o400)
        paths.set(key, filepath)
      }

      let command = input.command
      for (const reference of input.references.toSorted((left, right) => right.startIndex - left.startIndex)) {
        const filepath = paths.get(`${reference.provider}:${reference.id}`)
        if (!filepath) throw new Error(`Bash virtual file was not materialized: ${reference.provider}:${reference.id}`)
        command = command.slice(0, reference.startIndex) + shellQuote(filepath) + command.slice(reference.endIndex)
      }

      return { command, extraReadRoots: [tempDir], cleanup }
    } catch (error) {
      cleanup()
      throw error
    }
  }

  function parseCandidate(nodeType: string, text: string) {
    if (nodeType === "string" || nodeType === "raw_string") {
      const value = text.slice(1, -1)
      const matched = matchProvider(value)
      if (!matched) return
      return { ...matched, startOffset: 0, endOffset: text.length }
    }

    const valueStart = text.lastIndexOf("=") + 1
    const matched = matchProvider(text.slice(valueStart))
    if (!matched) return
    return { ...matched, startOffset: valueStart, endOffset: text.length }
  }

  function matchProvider(value: string) {
    const matched = BashVirtualPath.match(value)
    if (!matched) return
    return { provider: matched.provider, id: matched.id }
  }

  function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'"'"'`)}'`
  }
}
