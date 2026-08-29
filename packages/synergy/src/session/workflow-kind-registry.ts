/**
 * H3 workflow kind registry: product domains register extension workflow
 * kinds through descriptors instead of editing the core kind dispatch. The
 * persisted projection union stays closed for the core kinds; the `extension`
 * member carries registered kinds as `{ kind, payload }` (pure addition —
 * legacy records parse unchanged).
 *
 * The mutual-exclusion gate stays in core: `set`/`enable*` consult the
 * descriptor's declared conflict set and the workflow lock exactly like the
 * core kinds.
 */
export namespace WorkflowKindRegistry {
  export interface Descriptor {
    /** Stable kind id persisted as `workflow.kind` (extension member). */
    id: string
    /** Core kinds this extension is mutually exclusive with. */
    conflicts: string[]
    /** Enable the workflow on a session; owns conflict checks and the
     * durable projection write (runs under the workflow lock). */
    enable(input: { sessionID: string; args: Record<string, unknown> }): Promise<unknown>
    /** Release the domain's durable workflow state when the interactive
     * workflow is cleared. */
    disable?(sessionID: string): Promise<void>
  }

  const descriptors = new Map<string, Descriptor>()

  export function register(descriptor: Descriptor): void {
    descriptors.set(descriptor.id, descriptor)
  }

  export function get(id: string): Descriptor | undefined {
    return descriptors.get(id)
  }

  export function ids(): string[] {
    return [...descriptors.keys()].sort()
  }

  export function reset(): void {
    descriptors.clear()
  }

  /** Effective kind id of a persisted workflow projection: extension
   * records carry their real kind inside the envelope; core records are
   * their own kind. Registry dispatch sites key on this value. */
  export function effectiveKind(
    workflow: { kind: string; extension?: { kind: string } } | undefined,
  ): string | undefined {
    if (!workflow) return undefined
    if (workflow.kind !== "extension") return workflow.kind
    return workflow.extension?.kind ?? "extension"
  }
}
