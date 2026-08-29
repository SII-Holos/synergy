/**
 * S9c source inversion: the L1 session domain reaches the library product
 * domain (memory rows, memory/experience retrieval, experience encoding)
 * through this registry instead of importing it. The L4 product manifest
 * registers the implementation; unregistered access degrades quietly (no
 * memories, no retrieval, no experience encoding).
 */
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
    /** Experience encoding entry point for completed assistant messages. */
    onAssistantComplete(message: unknown): void
  }

  let provider: Provider | undefined

  export function register(value: Provider): void {
    provider = value
  }

  export function get(): Provider | undefined {
    return provider
  }

  export function listAlwaysMemories(): StoredMemoryRow[] {
    return provider?.listAlwaysMemories() ?? []
  }

  export function searchMemories(input: MemorySearchInput): Promise<RetrievedMemory[]> {
    return provider?.searchMemories(input) ?? Promise.resolve([])
  }

  export function retrieveExperiences(
    scopeID: string | undefined,
    query: string,
    options?: ExperienceOptions,
  ): Promise<ExperienceResult[]> {
    return provider?.retrieveExperiences(scopeID, query, options) ?? Promise.resolve([])
  }

  export function trackExperienceRetrieval(sessionID: string, experienceIDs: string[]): void {
    provider?.trackExperienceRetrieval(sessionID, experienceIDs)
  }

  /** Commit the session's pending experience-retrieval pull counters (the
   * turn that actually injected experience owns the commit). */
  export function commitExperienceRetrieval(sessionID: string): void {
    provider?.commitExperienceRetrieval(sessionID)
  }

  export function buildExperienceEvaluation(rewards: unknown, snapThreshold?: number): string | undefined {
    return provider?.buildExperienceEvaluation(rewards, snapThreshold)
  }

  export function writeExperienceDebugLog(
    sessionID: string,
    scopeID: string,
    query: string,
    results: ExperienceResult[],
    injected: string,
  ): void {
    provider?.writeExperienceDebugLog(sessionID, scopeID, query, results, injected)
  }

  export function onAssistantComplete(message: unknown): void {
    provider?.onAssistantComplete(message)
  }
}
