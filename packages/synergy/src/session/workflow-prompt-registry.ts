import type { Info as SessionInfo } from "./types"

/**
 * H2 workflow prompt registry: product workflow domains contribute their
 * Layer 2.5 system-prompt blocks and user-message wrappers through this
 * registry instead of being inlined in the session loop. The core owns the
 * interface and the resolution order; the bytes of each workflow's prompts
 * live in the owning domain.
 */
export namespace WorkflowPromptRegistry {
  /** Per-turn delivery facts the loop already computed; domains use them to
   * build turn-sensitive hint blocks (e.g. boss auto-delivery). */
  export interface PromptContext {
    deliveryMetadata: { channelPush: boolean; channelReplyToMessageId?: string } | undefined
  }

  export interface Contribution {
    kind: string
    /** Layer 2.5 system-prompt parts for sessions whose workflow.kind matches. */
    buildSystem?(session: SessionInfo, ctx: PromptContext): Promise<string[]> | string[]
    /** User-message wrapper text for this kind; resolve agent-specific text
     * from agentName exactly like the legacy agent×mode table did. */
    projectUserMessage?(query: string, agentName: string): string | undefined
    /** Control-sources that suppress user-message stamping for this kind. */
    controlSources?: string[]
  }

  const contributions = new Map<string, Contribution>()

  export function register(contribution: Contribution): void {
    contributions.set(contribution.kind, contribution)
  }

  export function get(kind: string): Contribution | undefined {
    return contributions.get(kind)
  }

  export function kinds(): string[] {
    return [...contributions.keys()].sort()
  }

  /** All control sources across registered contributions (legacy
   * CONTROL_SOURCES union, extended per-domain). */
  export function controlSources(): Set<string> {
    const sources = new Set<string>()
    for (const contribution of contributions.values()) {
      for (const source of contribution.controlSources ?? []) sources.add(source)
    }
    return sources
  }

  export function reset(): void {
    contributions.clear()
  }
}
