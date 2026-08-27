import { describe, expect, test, beforeEach, afterEach, afterAll, mock } from "bun:test"
import { LibraryDB, closeDB } from "../../src/library/database"
import { ExperienceRecall } from "../../src/library/experience-recall"
import { Config } from "../../src/config/config"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const DIMENSIONS = 8
const SCOPE = "scope-recall"
const REWARD_WEIGHTS = { outcome: 0.35, intent: 0.25, execution: 0.2, orchestration: 0.1, expression: 0.1 }

function fakeVector(): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))
}

function fakeEmbedding() {
  return { id: "emb", vector: fakeVector(), model: "test-model" }
}

function seedEvaluated(id: string) {
  LibraryDB.Experience.insert({
    id,
    sessionID: `sess-${id}`,
    scopeID: SCOPE,
    intent: `Handle the ${id} request flow`,
    intentEmbedding: fakeEmbedding(),
    scriptEmbedding: undefined,
    content: { script: `print("${id}")`, raw: id },
    metadata: {},
    retrievedExperienceIDs: [],
    createdAt: Date.now(),
  })
  LibraryDB.Experience.applyReward(id, { rewards: { outcome: 1 }, rewardWeights: REWARD_WEIGHTS, alpha: 0.3 })
}

describe.serial("ExperienceRecall UCB1 exploration", () => {
  const originalConfigCurrent = Config.current

  beforeEach(() => {
    LibraryDB.Experience.removeAll()
    ;(Config.current as any) = mock(async () => ({
      library: {
        experience: {
          retrieve: { topK: 10, epsilon: 0, wSim: 0.5, wQ: 0.5, explorationConstant: 0.5, simThreshold: 0 },
          learning: { rewardWeights: REWARD_WEIGHTS },
        },
      },
    }))
  })

  afterEach(() => {
    ;(Config.current as any) = originalConfigCurrent
  })

  afterAll(() => {
    closeDB()
  })

  test("cold candidate set gets no exploration bonus regardless of q_visits", async () => {
    seedEvaluated("exp-a")
    seedEvaluated("exp-b")
    // exp-b looks heavily rewarded under the old counter; the UCB term must ignore it.
    const conn = LibraryDB.connection()
    conn.prepare("UPDATE experience SET q_visits = 20 WHERE id = 'exp-b'").run()

    const results = await ExperienceRecall.retrieve(SCOPE, "query", { vector: fakeVector() })
    expect(results).toHaveLength(2)

    // Identical embeddings and zero Q values normalize to base 0, so score is
    // exactly the UCB bonus. A fully cold set must carry no exploration bonus.
    for (const r of results) {
      expect(r.retrievalCount).toBe(0)
      expect(r.score).toBe(0)
    }
  })

  test("UCB1 bonus decays with retrieval_count pulls and favors rarely-pulled arms", async () => {
    seedEvaluated("exp-a")
    seedEvaluated("exp-b")

    // Pull exp-a four times and exp-b once through the injection path.
    for (let i = 0; i < 4; i++) ExperienceRecall.trackRetrieval(`sess-${i}`, ["exp-a"])
    ExperienceRecall.trackRetrieval("sess-last", ["exp-b"])

    expect(LibraryDB.Experience.get("exp-a")!.retrieval_count).toBe(4)
    expect(LibraryDB.Experience.get("exp-b")!.retrieval_count).toBe(1)
    // Pulls must not touch the reward counter.
    expect(LibraryDB.Experience.get("exp-a")!.q_visits).toBe(0)

    const results = await ExperienceRecall.retrieve(SCOPE, "query", { vector: fakeVector() })
    const a = results.find((r) => r.id === "exp-a")!
    const b = results.find((r) => r.id === "exp-b")!

    // ln(N)=ln(5); bonuses: a = 0.5*sqrt(ln5/4), b = 0.5*sqrt(ln5).
    const ln5 = Math.log(5)
    expect(a.score).toBeCloseTo(0.5 * Math.sqrt(ln5 / 4), 10)
    expect(b.score).toBeCloseTo(0.5 * Math.sqrt(ln5), 10)
    expect(b.score).toBeGreaterThan(a.score)

    // Reward-path visits must not inflate the exploration term.
    const conn = LibraryDB.connection()
    conn.prepare("UPDATE experience SET q_visits = 50 WHERE id = 'exp-b'").run()
    const after = await ExperienceRecall.retrieve(SCOPE, "query", { vector: fakeVector() })
    const bAfter = after.find((r) => r.id === "exp-b")!
    expect(bAfter.score).toBeCloseTo(0.5 * Math.sqrt(ln5), 10)
  })

  test("pulls do not mutate updated_at and counting is best-effort", () => {
    seedEvaluated("exp-ts")
    const before = LibraryDB.Experience.get("exp-ts")!
    ExperienceRecall.trackRetrieval("sess-ts", ["exp-ts"])
    const after = LibraryDB.Experience.get("exp-ts")!
    expect(after.retrieval_count).toBe(1)
    expect(after.q_visits).toBe(0)
    expect(after.updated_at).toBe(before.updated_at)
    // Unknown ids are no-ops and must never throw into the injection path.
    expect(() => ExperienceRecall.trackRetrieval("sess-x", ["no-such-id"])).not.toThrow()
  })

  test("uninjectable arms never enter the candidate set", async () => {
    seedEvaluated("exp-good")
    LibraryDB.Experience.insert({
      id: "exp-bad-intent",
      sessionID: "sess-bad-intent",
      scopeID: SCOPE,
      intent: "x".repeat(200),
      intentEmbedding: fakeEmbedding(),
      scriptEmbedding: undefined,
      content: { script: 'print("bad")', raw: "bad" },
      metadata: {},
      retrievedExperienceIDs: [],
      createdAt: Date.now(),
    })
    LibraryDB.Experience.applyReward("exp-bad-intent", {
      rewards: { outcome: 1 },
      rewardWeights: REWARD_WEIGHTS,
      alpha: 0.3,
    })
    LibraryDB.Experience.insert({
      id: "exp-noscript",
      sessionID: "sess-noscript",
      scopeID: SCOPE,
      intent: "Handle the no-script request flow",
      intentEmbedding: fakeEmbedding(),
      scriptEmbedding: undefined,
      content: { userInput: "q", raw: "no script here" },
      metadata: {},
      retrievedExperienceIDs: [],
      createdAt: Date.now(),
    })
    LibraryDB.Experience.applyReward("exp-noscript", {
      rewards: { outcome: 1 },
      rewardWeights: REWARD_WEIGHTS,
      alpha: 0.3,
    })

    // Injection path: only injectable arms are candidates, so an arm that
    // would be selected then discarded cannot occupy a topK slot or hold a
    // perpetual exploration bonus.
    const strict = await ExperienceRecall.retrieve(SCOPE, "query", { vector: fakeVector(), requireScript: true })
    expect(strict.map((r) => r.id)).toEqual(["exp-good"])

    // Read paths (server search, boss briefing) keep script-less arms visible
    // but still exclude invalid intents, matching the old post-selection
    // filter's visible output without wasting topK slots on discarded arms.
    const loose = await ExperienceRecall.retrieve(SCOPE, "query", { vector: fakeVector() })
    expect(loose.map((r) => r.id).sort()).toEqual(["exp-good", "exp-noscript"])
  })
})
