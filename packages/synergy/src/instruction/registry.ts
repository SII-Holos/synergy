import { Log } from "../util/log"

const log = Log.create({ service: "instruction.registry" })

/**
 * H7 instruction source registry: instruction domains (skill, command)
 * register their template rendering pipeline instead of the session loop
 * forking on the source kind. The engine owns shared text semantics; the
 * source owns policy stages (command: trim + shell expansion) and listing.
 */
export namespace InstructionRegistry {
  export interface Source {
    kind: string
    /** Render a template with arguments into ordered text parts. */
    render(input: { template: string; arguments: string }): Promise<string[]>
    /** Placeholder hints surfaced to agents for this source. */
    hints(): string[]
    /** List instruction identifiers for discovery surfaces. */
    list?(): Promise<string[]>
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
