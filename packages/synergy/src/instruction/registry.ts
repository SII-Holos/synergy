import { Log } from "../util/log"

const log = Log.create({ service: "instruction.registry" })

/**
 * H7 instruction source registry: instruction domains (skill, command)
 * register their template rendering pipeline instead of the session loop
 * forking on the source kind. The engine owns shared text semantics; the
 * source owns policy stages (command: trim + shell expansion) and listing.
 * Sources may also expose an instruction catalog so generic L1 surfaces
 * (the skill tool) can list, load, and reference instructions without
 * importing the owning domain.
 */
export namespace InstructionRegistry {
  export interface Diagnostic {
    name: string
    code: string
    severity: "error" | "warning" | "info"
    path?: string
    message: string
  }

  export interface Entry {
    name: string
    description: string
    source: string
    scope: string
    compatibility: string
    directory: string
    /** Invocable by the model through the generic skill tool. */
    model: boolean
    warnings: string[]
    unsupported: string[]
    content(): Promise<string>
    references(): Promise<string[]>
    reference(name: string): Promise<string | undefined>
  }

  export interface Source {
    kind: string
    /** Render a template with arguments into ordered text parts. */
    render(input: { template: string; arguments: string }): Promise<string[]>
    /** Placeholder hints surfaced to agents for this source. */
    hints(): string[]
    /** List instruction identifiers for discovery surfaces. */
    list?(): Promise<string[]>
    /** Catalog entries for generic instruction consumers. */
    entries?(): Promise<Entry[]>
    entry?(name: string): Promise<Entry | undefined>
    diagnostics?(): Promise<Diagnostic[]>
  }

  const sources = new Map<string, Source>()

  export function register(source: Source): void {
    sources.set(source.kind, source)
  }

  export function get(kind: string): Source | undefined {
    return sources.get(kind)
  }

  export function kinds(): string[] {
    return [...sources.keys()].sort()
  }

  /** Render through the registered source; unknown kinds log and return the
   * trimmed template unchanged so an unregistered domain degrades quietly
   * instead of failing the session loop. */
  export async function render(kind: string, input: { template: string; arguments: string }): Promise<string[]> {
    const source = sources.get(kind)
    if (!source) {
      log.warn("instruction source is not registered; returning template unchanged", { kind })
      return [input.template.trim()]
    }
    return source.render(input)
  }

  export function reset(): void {
    sources.clear()
  }
}
