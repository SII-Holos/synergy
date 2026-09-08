import { SessionLibraryRecall } from "./library-recall"
import { ExperienceEncoder } from "./experience-encoder"
import { ExperienceRecall } from "./experience-recall"
import { LibraryDB } from "./database"
import { MemoryRecall } from "./memory-recall"
import { readConfig } from "./config-schema"
import { SessionContextContributions } from "@ericsanchezok/synergy-harness/session/context-contributions"
import { buildMemoryContext, buildAlwaysOnlyMemoryResult } from "./recall"

export function registerLibrarySessionRecall() {
  SessionLibraryRecall.register({
    listAlwaysMemories: () => LibraryDB.Memory.list({ recallModes: ["always"] }),
    searchMemories: (input) => MemoryRecall.search(input),
    retrieveExperiences: (scopeID, query, options) =>
      ExperienceRecall.retrieve(scopeID, query, {
        ...(options?.simThreshold !== undefined ? { simThreshold: options.simThreshold } : {}),
        ...(options?.vector !== undefined ? { vector: options.vector } : {}),
        ...(options?.requireScript !== undefined ? { requireScript: options.requireScript } : {}),
      }),
    trackExperienceRetrieval: (sessionID, experienceIDs) => ExperienceRecall.trackRetrieval(sessionID, experienceIDs),
    commitExperienceRetrieval: (sessionID) => ExperienceRecall.commitRetrieval(sessionID),
    buildExperienceEvaluation: (rewards, snapThreshold) =>
      ExperienceRecall.buildEvaluation(rewards as LibraryDB.Experience.Rewards, snapThreshold),
    writeExperienceDebugLog: (sessionID, scopeID, query, results, injected) =>
      ExperienceRecall.writeDebugLog(sessionID, scopeID, query, results as ExperienceRecall.Result[], injected),
    onAssistantComplete: (message) =>
      ExperienceEncoder.onComplete(message as Parameters<typeof ExperienceEncoder.onComplete>[0]),
  })
  return SessionContextContributions.register("library", {
    async enabled({ isTopSession }) {
      const { library } = await readConfig()
      return library?.memory?.enabled !== false || (isTopSession && library?.experience?.retrieve !== false)
    },
    async contribute(input) {
      const { library } = await readConfig()
      if (!input.isTopSession) {
        const result = buildAlwaysOnlyMemoryResult()
        return result ? { context: result.context, injection: {} } : undefined
      }
      return buildMemoryContext(input.sessionID, input.scopeID, input.messages, library, input.signal)
    },
    async fallback() {
      const { library } = await readConfig()
      if (library?.memory?.enabled === false) return undefined
      return buildAlwaysOnlyMemoryResult()
    },
    committed(sessionID, injection) {
      if (injection.experience) ExperienceRecall.commitRetrieval(sessionID)
    },
    onAssistantComplete: (message) => ExperienceEncoder.onComplete(message),
  })
}
