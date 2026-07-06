import { describe, expect, test } from "bun:test"
import { planCompactionReplace } from "./session-compaction"

const item = (id: string, partIds: string[] = []) => ({
  info: { id },
  parts: partIds.map((p) => ({ id: p })),
})

describe("planCompactionReplace", () => {
  test("keeps id-sorted messages and their sorted parts", () => {
    const plan = planCompactionReplace(["m_1", "m_2"], [item("m_2", ["p_2", "p_1"]), item("m_1", ["p_a"])])
    expect(plan.keep.map((m) => m.id)).toEqual(["m_1", "m_2"])
    expect(plan.parts["m_2"].map((p) => p.id)).toEqual(["p_1", "p_2"])
    expect(plan.parts["m_1"].map((p) => p.id)).toEqual(["p_a"])
  })

  test("drops part buckets for messages compacted away", () => {
    // m_1 and m_2 were in the store; compaction leaves only m_2.
    const plan = planCompactionReplace(["m_1", "m_2"], [item("m_2")])
    expect(plan.dropPartMessageIds).toEqual(["m_1"])
    expect(plan.keep.map((m) => m.id)).toEqual(["m_2"])
  })

  test("caps to the newest `cap` messages", () => {
    const fetched = ["m_1", "m_2", "m_3", "m_4"].map((id) => item(id))
    const plan = planCompactionReplace([], fetched, 2)
    expect(plan.keep.map((m) => m.id)).toEqual(["m_3", "m_4"])
    // parts entries exist only for kept ids (empty here, since no parts given)
    expect(Object.keys(plan.parts).sort()).toEqual(["m_3", "m_4"])
  })

  test("ignores items without an id", () => {
    const plan = planCompactionReplace([], [item("m_1"), { info: { id: "" }, parts: [] }])
    expect(plan.keep.map((m) => m.id)).toEqual(["m_1"])
  })

  test("empty fetch keeps nothing and drops all current part buckets", () => {
    const plan = planCompactionReplace(["m_1", "m_2"], [])
    expect(plan.keep).toEqual([])
    expect(plan.dropPartMessageIds).toEqual(["m_1", "m_2"])
  })
})
