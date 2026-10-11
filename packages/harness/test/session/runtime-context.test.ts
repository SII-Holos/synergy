import { describe, expect, test } from "bun:test"
import { RuntimeAdvisory } from "../../src/session/runtime-context"

const memory = { id: "memory", state: "present" as const, text: "Remember the complete reference: ALPHA-419." }
const warning = { id: "git-health", state: "present" as const, text: "There are uncommitted changes." }

describe("durable advisory observations", () => {
  test("retains complete information once and appends only changed sources", () => {
    const first = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory, warning], previous: [] })!
    expect(first.text).toContain(memory.text)
    expect(first.text).toContain(warning.text)
    const previous = [JSON.parse(JSON.stringify(first.metadata))]
    expect(RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory, warning], previous })).toBeUndefined()
    const change = { ...warning, text: "There are five uncommitted changes." }
    const next = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory, change], previous })!
    expect(next.text).toContain(change.text)
    expect(next.text).not.toContain(memory.text)
    expect(next.metadata.sources.map((source) => source.id)).toEqual(["git-health"])
    expect(first.text).toContain(warning.text)
  })

  test("distinguishes an unavailable report from a confirmed resolution", () => {
    const first = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [warning], previous: [] })!
    const unavailable = RuntimeAdvisory.prepare({
      scope: "workspace-a",
      sources: [{ id: "git-health", state: "unavailable" }],
      previous: [first.metadata],
    })!
    expect(unavailable.metadata.sources[0].state).toBe("unavailable")
    expect(unavailable.text).toContain("not a confirmed current status")
    const clear = RuntimeAdvisory.prepare({
      scope: "workspace-a",
      sources: [{ id: "git-health", state: "cleared" }],
      previous: [first.metadata, unavailable.metadata],
    })!
    expect(clear.metadata.sources[0].state).toBe("cleared")
    expect(clear.text).toContain("no longer active")
  })

  test("clears a removed source and restores all observations after a context boundary", () => {
    const first = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory, warning], previous: [] })!
    const next = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory], previous: [first.metadata] })!
    expect(next.metadata.sources).toMatchObject([{ id: "git-health", state: "cleared" }])
    const boundary = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory], previous: [] })!
    expect(boundary.text).toContain(memory.text)
    const rebound = RuntimeAdvisory.prepare({
      scope: "workspace-b",
      sources: [memory],
      previous: [first.metadata, next.metadata],
    })!
    expect(rebound.text).toContain(memory.text)
  })

  test("retries are idempotent and confirmation never replaces changed observations", () => {
    const first = RuntimeAdvisory.prepare({ scope: "workspace-a", sources: [memory], previous: [] })!
    const input = { scope: "workspace-a", sources: [memory], previous: [first.metadata] }
    expect(RuntimeAdvisory.prepare(input)).toBeUndefined()
    const confirm = RuntimeAdvisory.prepare({ ...input, confirm: true })!
    expect(confirm.metadata.sources).toEqual([])
    expect(confirm.text).toContain("unchanged")
    expect(RuntimeAdvisory.prepare({ ...input, previous: [...input.previous, confirm.metadata] })).toBeUndefined()
  })

  test("validates versions and refuses ambiguous source identities", () => {
    expect(() => RuntimeAdvisory.Metadata.parse({ version: 99, sources: [] })).toThrow()
    expect(() => RuntimeAdvisory.prepare({ scope: "a", sources: [memory, memory], previous: [] })).toThrow()
  })
})
