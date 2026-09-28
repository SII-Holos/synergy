import type { Node } from "web-tree-sitter"
import type { Executor } from "@ericsanchezok/synergy-harness/environment/executor"
import { ToolNoteSource } from "@ericsanchezok/synergy-harness/tool/note-source"
import { BashVirtualPath } from "@ericsanchezok/synergy-harness/tool/virtual-path"

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
    digest?: string
    cleanup(): Promise<void>
  }

  interface Provider {
    extension: string
    read(scopeID: string, id: string): Promise<string>
  }

  const noteSource = () => {
    const source = ToolNoteSource.get()
    if (!source) throw new Error("Note virtual-file source is not registered")
    return source
  }

  const providers = {
    note: {
      get extension() {
        return noteSource().noteExtension
      },
      read(scopeID: string, id: string) {
        return noteSource().readNoteMarkdown(scopeID, id)
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
    executor: Executor
    executionID: string
    shell: string
    platform: string
  }): Promise<Materialization> {
    if (input.references.length === 0) {
      return { command: input.command, extraReadRoots: [], async cleanup() {} }
    }

    const executor = input.executor
    if (!executor.prepareInputs || !executor.discardInputs)
      throw new Error("Selected Environment cannot stage virtual files")
    const cleanup = () => executor.discardInputs!(input.executionID)

    try {
      const unique = new Map<string, Reference>()
      for (const reference of input.references) {
        unique.set(`${reference.provider}:${reference.id}`, reference)
      }

      const paths = new Map<string, string>()
      const files: { name: string; data: string }[] = []
      let index = 0
      for (const [key, reference] of unique.entries()) {
        const provider = providers[reference.provider]
        const content = await provider.read(input.scopeID, reference.id)
        const name = `${index++}${provider.extension}`
        files.push({ name, data: Buffer.from(content).toString("base64") })
        paths.set(key, name)
      }
      const prepared = await executor.prepareInputs({ id: input.executionID, files })

      let command = input.command
      for (const reference of input.references.toSorted((left, right) => right.startIndex - left.startIndex)) {
        const name = paths.get(`${reference.provider}:${reference.id}`)
        const filepath = name && prepared.paths[name]
        if (!filepath) throw new Error(`Bash virtual file was not materialized: ${reference.provider}:${reference.id}`)
        command =
          command.slice(0, reference.startIndex) +
          shellQuote(filepath, input.shell, input.platform) +
          command.slice(reference.endIndex)
      }

      return { command, extraReadRoots: Object.values(prepared.paths), digest: prepared.digest, cleanup }
    } catch (error) {
      await cleanup().catch(() => {})
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

  function shellQuote(value: string, shell: string, platform: string) {
    const name = shell.split(/[\\/]/).at(-1)?.toLowerCase()
    if (platform === "win32" && ["cmd", "cmd.exe"].includes(name ?? "")) {
      if (/["%!\r\n]/.test(value)) throw new Error("Execution input path cannot be quoted safely for cmd")
      return `"${value}"`
    }
    if (platform === "win32" && ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(name ?? ""))
      return `'${value.replaceAll("'", "''")}'`
    return `'${value.replaceAll("'", `'"'"'`)}'`
  }
}
