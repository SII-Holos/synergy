import { expect, test } from "bun:test"
import type { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { buildMemoryContext, buildAlwaysOnlyMemoryResult } from "../src/recall"
import { SessionLibraryRecall } from "../src/library-recall"
import { Embedding } from "../src/vector/embedding"

test("disabled Library does not embed or read memories", async () => {
  const original = Embedding.generate
  let embeddingCalls = 0
  let memoryCalls = 0
  Embedding.generate = async () => {
    embeddingCalls++
    throw new Error("disabled embedding")
  }
  const unregister = SessionLibraryRecall.register({
    ...emptyProvider(),
    listAlwaysMemories() {
      memoryCalls++
      return []
    },
  })
  try {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Research question" }] },
    ] as MessageV2.WithParts[]
    expect(
      await buildMemoryContext("session", "home", messages, {
        memory: { enabled: false },
        experience: { retrieve: false },
      }),
    ).toBeUndefined()
    expect(embeddingCalls).toBe(0)
    expect(memoryCalls).toBe(0)
  } finally {
    Embedding.generate = original
    unregister()
  }
})

test("enabled Library preserves always-memory prompt and injection metadata", async () => {
  const unregister = SessionLibraryRecall.register({
    ...emptyProvider(),
    listAlwaysMemories: () => [
      { id: "memory", title: "Research records", content: "Report in Chinese.", category: "workflow" },
    ],
  })
  try {
    const result = await buildMemoryContext("session", "home", [], {
      memory: { enabled: true },
      experience: { retrieve: false },
    })
    expect(result).toEqual(buildAlwaysOnlyMemoryResult())
    expect(result?.injection.memory).toBe(
      [
        "<active-memory>",
        '<category name="workflow" instruction="Recurring ways of working, process expectations, and execution habits that shape how tasks should be handled.">',
        '<entry title="Research records">',
        "Report in Chinese.",
        "</entry>",
        "</category>",
        "</active-memory>",
      ].join("\n"),
    )
    expect(result?.context).toContain("`memory_search`")
    expect(result?.injection.experience).toBeUndefined()
  } finally {
    unregister()
  }
})

function emptyProvider(): SessionLibraryRecall.Provider {
  return {
    listAlwaysMemories: () => [],
    searchMemories: async () => [],
    retrieveExperiences: async () => [],
    trackExperienceRetrieval() {},
    commitExperienceRetrieval() {},
    buildExperienceEvaluation: () => undefined,
    writeExperienceDebugLog() {},
    onAssistantComplete() {},
  }
}

test("context contribution combines filtered semantic memory with attributed experience retrieval", async () => {
  const original = Embedding.generate
  const searches: SessionLibraryRecall.MemorySearchInput[] = []
  const tracked: string[][] = []
  const debug: { query: string; injected: string }[] = []
  const embedded: string[] = []
  Embedding.generate = async (input) => {
    embedded.push(input.text)
    return { id: input.id, vector: [1, 0, 0, 0], model: "fixture" }
  }
  const unregister = SessionLibraryRecall.register({
    ...emptyProvider(),
    listAlwaysMemories: () => [{ id: "always", title: "Workflow", content: "Keep evidence", category: "workflow" }],
    async searchMemories(input) {
      searches.push(input)
      const category = input.categories?.[0]
      if (category === "coding")
        return [
          { id: "strong", title: "Determinism", content: "Seed every trial", category, similarity: 0.95 },
          { id: "weak", title: "Weak match", content: "Discard weak memory", category, similarity: 0.6 },
        ]
      if (category === "insight")
        return [{ id: "noise", title: "Noise", content: "Discard noise", category, similarity: 0.4 }]
      return []
    },
    async retrieveExperiences(scopeID, query, options) {
      expect(scopeID).toBe("scope-research")
      expect(query).toBe("newest question")
      expect(options).toMatchObject({ vector: [1, 0, 0, 0], requireScript: true })
      return [
        {
          id: "positive",
          intent: "Reproduce a result",
          script: "seed(7)",
          similarity: 0.9,
          qValue: 0.8,
          rewards: { outcome: 1 },
        },
        { id: "neutral", intent: "Inspect baseline", script: "inspect()", similarity: 0.75, qValue: 0, rewards: {} },
      ]
    },
    trackExperienceRetrieval(sessionID, ids) {
      tracked.push([sessionID, ...ids])
    },
    buildExperienceEvaluation(rewards) {
      return (rewards as { outcome?: number }).outcome === 1 ? "Successful result" : undefined
    },
    writeExperienceDebugLog(_session, _scope, query, _results, injected) {
      debug.push({ query, injected })
    },
  })
  try {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "old question" }] },
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "newest question" },
          { type: "text", text: "system-only", synthetic: true },
        ],
      },
    ] as MessageV2.WithParts[]
    const result = await buildMemoryContext("session-research", "scope-research", messages, {
      memory: {
        enabled: true,
        retrieval: { simThreshold: 0.2, topK: 4, categories: { coding: { simThreshold: 0.9, topK: 2 } } },
      },
      experience: { retrieve: true },
    })
    expect(embedded).toEqual(["newest question"])
    expect(searches).toHaveLength(SessionLibraryRecall.MEMORY_CATEGORIES.length)
    expect(searches.find((input) => input.categories?.[0] === "coding")).toMatchObject({
      topK: 2,
      recallModes: ["contextual"],
      vector: [1, 0, 0, 0],
    })
    expect(result?.injection.memory).toContain("Keep evidence")
    expect(result?.injection.memory).toContain('similarity="0.950"')
    expect(result?.injection.memory).toContain("Seed every trial")
    expect(result?.context).not.toContain("Discard")
    expect(result?.injection.experience).toContain('<experience sim="0.900" q="0.800">')
    expect(result?.injection.experience).toContain("<script>seed(7)</script>")
    expect(result?.injection.experience).toContain("<evaluation>Successful result</evaluation>")
    expect(result?.injection.experience).toContain("<script>inspect()</script>")
    expect(tracked).toEqual([["session-research", "positive", "neutral"]])
    expect(debug).toEqual([{ query: "newest question", injected: result!.injection.experience! }])
  } finally {
    Embedding.generate = original
    unregister()
  }
})

test("failed semantic retrieval retains always-memory context and cancellation still propagates", async () => {
  const original = Embedding.generate
  Embedding.generate = async () => {
    throw new Error("embedding unavailable")
  }
  const unregister = SessionLibraryRecall.register({
    ...emptyProvider(),
    listAlwaysMemories: () => [
      { id: "always", title: "Evidence", content: "Preserve observations", category: "knowledge" },
    ],
    retrieveExperiences: async () => {
      throw new Error("retrieval unavailable")
    },
  })
  try {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "research query" }] },
    ] as MessageV2.WithParts[]
    const result = await buildMemoryContext("session", "scope", messages)
    expect(result?.injection.memory).toContain("Preserve observations")
    expect(result?.injection.experience).toBeUndefined()
    await expect(
      buildMemoryContext("session", "scope", messages, undefined, AbortSignal.abort(new Error("research cancelled"))),
    ).rejects.toThrow("research cancelled")
  } finally {
    Embedding.generate = original
    unregister()
  }
})
