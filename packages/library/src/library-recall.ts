import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
export namespace SessionLibraryRecall {
  /** Persisted memory category vocabulary mirrored for prompt rendering. */
  export const MEMORY_CATEGORIES = [
    "user",
    "self",
    "relationship",
    "interaction",
    "workflow",
    "coding",
    "writing",
    "asset",
    "insight",
    "knowledge",
    "personal",
    "general",
  ] as const
  export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

  export type MemoryRecallMode = "always" | "contextual" | "search_only"

  export interface StoredMemoryRow {
    id: string
    title: string
    content: string
    category: MemoryCategory
  }

  export interface RetrievedMemory {
    id: string
    title: string
    content: string
    category: MemoryCategory
    similarity: number
  }

  export interface MemorySearchInput {
    query: string
    vector?: number[]
    topK?: number
    categories?: MemoryCategory[]
    recallModes?: MemoryRecallMode[]
  }

  /** Experience results are pass-throughs beyond the fields declared here:
   * rendering reads these fields and hands the same objects back to the
   * evaluation and debug-log calls. */
  export interface ExperienceResult {
    id: string
    intent: string
    similarity: number
    qValue: number
    script: string | null
    rewards: unknown
  }

  export interface ExperienceOptions {
    simThreshold?: number
    vector?: number[]
    /** Server-side filter: only return experiences that carry a script. */
    requireScript?: boolean
  }

  export interface Provider {
    listAlwaysMemories(): StoredMemoryRow[]
    searchMemories(input: MemorySearchInput): Promise<RetrievedMemory[]>
    retrieveExperiences(
      scopeID: string | undefined,
      query: string,
      options?: ExperienceOptions,
    ): Promise<ExperienceResult[]>
    trackExperienceRetrieval(sessionID: string, experienceIDs: string[]): void
    /** Commit pending experience-retrieval pull counters for the session. */
    commitExperienceRetrieval(sessionID: string): void
    buildExperienceEvaluation(rewards: unknown, snapThreshold?: number): string | undefined
    writeExperienceDebugLog(
      sessionID: string,
      scopeID: string,
      query: string,
      results: ExperienceResult[],
      injected: string,
    ): void
  }

  const runtimeState = RuntimeContext.state(() => ({
    provider: undefined as Provider | undefined,
  }))

  export function register(value: Provider): () => void {
    const instanceState = runtimeState()

    const previous = instanceState.provider
    instanceState.provider = value
    return () => {
      const instanceState = runtimeState()

      if (instanceState.provider === value) instanceState.provider = previous
    }
  }

  export function get(): Provider | undefined {
    const instanceState = runtimeState()

    return instanceState.provider
  }

  export function listAlwaysMemories(): StoredMemoryRow[] {
    const instanceState = runtimeState()

    return instanceState.provider?.listAlwaysMemories() ?? []
  }

  export function searchMemories(input: MemorySearchInput): Promise<RetrievedMemory[]> {
    const instanceState = runtimeState()

    return instanceState.provider?.searchMemories(input) ?? Promise.resolve([])
  }

  export function retrieveExperiences(
    scopeID: string | undefined,
    query: string,
    options?: ExperienceOptions,
  ): Promise<ExperienceResult[]> {
    const instanceState = runtimeState()

    return instanceState.provider?.retrieveExperiences(scopeID, query, options) ?? Promise.resolve([])
  }

  export function trackExperienceRetrieval(sessionID: string, experienceIDs: string[]): void {
    const instanceState = runtimeState()

    instanceState.provider?.trackExperienceRetrieval(sessionID, experienceIDs)
  }

  /** Commit the session's pending experience-retrieval pull counters (the
   * turn that actually injected experience owns the commit). */
  export function commitExperienceRetrieval(sessionID: string): void {
    const instanceState = runtimeState()

    instanceState.provider?.commitExperienceRetrieval(sessionID)
  }

  export function buildExperienceEvaluation(rewards: unknown, snapThreshold?: number): string | undefined {
    const instanceState = runtimeState()

    return instanceState.provider?.buildExperienceEvaluation(rewards, snapThreshold)
  }

  export function writeExperienceDebugLog(
    sessionID: string,
    scopeID: string,
    query: string,
    results: ExperienceResult[],
    injected: string,
  ): void {
    const instanceState = runtimeState()

    instanceState.provider?.writeExperienceDebugLog(sessionID, scopeID, query, results, injected)
  }
}
