import { SessionLibraryRecall } from "../session/library-recall"
import { ExperienceEncoder } from "./experience-encoder"
import { ExperienceRecall } from "./experience-recall"
import { LibraryDB } from "./database"
import { MemoryRecall } from "./memory-recall"

/**
 * S9c source inversion: the L1 session domain reaches library memory and
 * experience recall (and experience encoding on assistant completion)
 * through the SessionLibraryRecall registry instead of importing the library
 * product domain. Loaded through src/product-registration.ts.
 */
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
}
