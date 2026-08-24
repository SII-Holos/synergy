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
})
