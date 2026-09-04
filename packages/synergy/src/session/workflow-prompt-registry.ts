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
   * build turn-sensitive hint blocks (e.g. boss reply target). */
  export interface PromptContext {
    deliveryMetadata:
      | {
          channelPush: boolean
          channelReplyToMessageId?: string
          /** Channel chat the user message arrived from (boss explicit replies). */
          channelChatId?: string
          /** Chat type (dm/group) of the inbound message, when unambiguous. */
          channelChatType?: "dm" | "group"
        }
      | undefined
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
    /** Called when the session loop exits with an error for a session of
     * this kind (lightloop: mark the loop failed). */
    onLoopError?(sessionID: string, error: unknown): Promise<void>
    /** Cancel the workflow for a session of this kind (lightloop: abort +
     * terminal status). Returns the updated session. */
    cancel?(sessionID: string): Promise<SessionInfo>
    /** Reattach domain-owned timers after a plugin reload. */
    reattachPluginTimers?(): Promise<void>
    /** Prepare the domain runtime before the session loop starts
     * (lattice: subscribe + reconcile persisted runs). */
    init?(): void
    /** Flush per-turn counters when the session loop exits (lattice:
     * model-call accounting into the durable run). */
    finalize?(sessionID: string, scopeID: string): Promise<void>
    /** Record one model call for a session of this kind (lattice: budget). */
    onModelCall?(sessionID: string): void
    /** Whether the persisted workflow still owns recovery for this session
     * (lattice: active or paused run). */
    isActive?(session: SessionInfo): Promise<boolean>
    /** Enable the workflow on a session; owns locking, conflict checks,
     * durable projection, and rollback (lattice). */
    enable?(
      sessionID: string,
      input: { mode: "auto" | "collaborative"; maxModelCalls?: number; goal?: string },
    ): Promise<SessionInfo>
    /** Release the domain's durable workflow state when the interactive
     * workflow is cleared (lattice: disable the run). */
    disable?(sessionID: string): Promise<void>
    /** Classify a domain error thrown by enable as a user-facing workflow
     * conflict (lattice: StateConflict → reply reason). */
    workflowConflict?(error: unknown): { reason: string } | undefined
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
