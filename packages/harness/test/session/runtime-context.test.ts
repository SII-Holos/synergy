import { describe, expect, test } from "bun:test"
import { RuntimeAdvisory } from "../../src/session/runtime-context"
import { MessageV2 } from "../../src/session/message-v2"
import { ContextUsage } from "../../src/session/context-usage"
import { upgradeRuntimeContextRecord } from "../../src/session/runtime-context-migration"
import { RuntimeContextMetadata } from "../../src/session/runtime-context-schema"

const memory = { id: "memory", state: "present" as const, text: "Remember the complete reference: ALPHA-419." }
const warning = { id: "git-health", state: "present" as const, text: "There are uncommitted changes." }

describe("durable advisory observations", () => {
  test("concise observations keep complete Unicode knowledge and verifiable source ranges", () => {
    const knowledge = {
      id: 'entry<&"',
      kind: "knowledge" as const,
      state: "present" as const,
      text: "完整正文 🧪\n\nLine two.\n",
    }
    const first = RuntimeAdvisory.prepare({
      scope: "a",
      sources: [knowledge, { id: "empty", state: "present", text: "" }],
      previous: [],
    })!
    expect(first.text.startsWith("<runtime-context>\n<context-source")).toBe(true)
    expect(first.text).toContain(knowledge.text)
    expect(first.text).toContain('id="entry&lt;&amp;&quot;"')
    expect(first.metadata.sources[0]!.revision).toBe(RuntimeAdvisory.knowledgeRevision(knowledge.text))
    expect(RuntimeContextMetadata.hash(first.text)).toBe(first.metadata.contentHash)
    for (const source of first.metadata.sources) expect(RuntimeContextMetadata.verified(source, first.text)).toBe(true)
    const cleared = RuntimeAdvisory.prepare({ scope: "a", sources: [knowledge], previous: [first.metadata] })!
    expect(cleared.metadata.sources).toMatchObject([{ id: "empty", state: "cleared" }])
  })

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
    expect(unavailable.text).toContain("Current report unavailable.")
    const clear = RuntimeAdvisory.prepare({
      scope: "workspace-a",
      sources: [{ id: "git-health", state: "cleared" }],
      previous: [first.metadata, unavailable.metadata],
    })!
    expect(clear.metadata.sources[0].state).toBe("cleared")
    expect(clear.text).toContain("Source no longer active.")
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

  test("knowledge definitions survive deselection and a return to a retained version", () => {
    const a = { ...memory, kind: "knowledge" as const }
    const x = { id: "memory:x", kind: "knowledge" as const, state: "present" as const, text: "Additional fact X" }
    const select = (ids: string[]) => RuntimeAdvisory.present("selection", ids.join(","))
    const first = RuntimeAdvisory.prepare({ scope: "a", sources: [a, select(["a"])], previous: [] })!
    const added = RuntimeAdvisory.prepare({
      scope: "a",
      sources: [a, x, select(["a", "x"])],
      previous: [first.metadata],
    })!
    expect(added.text).not.toContain(a.text)
    const removed = RuntimeAdvisory.prepare({
      scope: "a",
      sources: [a, select(["a"])],
      previous: [first.metadata, added.metadata],
    })!
    expect(removed.metadata.sources.map((source) => source.id)).toEqual(["selection"])
    const returned = RuntimeAdvisory.prepare({
      scope: "a",
      sources: [a, x, select(["a", "x"])],
      previous: [first.metadata, added.metadata, removed.metadata],
    })!
    expect(returned.text).not.toContain(x.text)
    expect(returned.metadata.sources.map((source) => source.id)).toEqual(["selection"])
    const boundary = RuntimeAdvisory.prepare({ scope: "a", sources: [a, x, select(["a", "x"])], previous: [] })!
    expect(boundary.text).toContain(a.text)
    expect(boundary.text).toContain(x.text)
  })

  test("pending observations and absent events do not clear a confirmed state", () => {
    const time = {
      id: "time",
      kind: "event" as const,
      state: "present" as const,
      text: "This input arrived after ten minutes.",
    }
    const first = RuntimeAdvisory.prepare({ scope: "a", sources: [warning, time], previous: [] })!
    expect(
      RuntimeAdvisory.prepare({
        scope: "a",
        sources: [{ id: warning.id, state: "pending" }],
        previous: [first.metadata],
      }),
    ).toBeUndefined()
    expect(RuntimeAdvisory.prepare({ scope: "a", sources: [warning], previous: [first.metadata] })).toBeUndefined()
  })

  test("a modified old observation does not invalidate unrelated knowledge or a later repair", async () => {
    const sources = [{ ...memory, kind: "knowledge" as const }, warning]
    const first = RuntimeAdvisory.prepare({ scope: "a", sources, previous: [] })!
    const root: MessageV2.User = {
      id: "msg_root",
      rootID: "msg_root",
      sessionID: "ses_test",
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
    }
    const original = RuntimeAdvisory.message({
      id: "msg_first",
      partID: "prt_first",
      created: 2,
      root,
      observation: first,
    })
    const changed = structuredClone(original)
    if (changed.parts[0].type === "text")
      changed.parts[0].text = changed.parts[0].text.replace(warning.text, "Rewritten warning")
    const repair = RuntimeAdvisory.prepare({ scope: "a", sources, previous: RuntimeAdvisory.history([changed]) })!
    expect(repair.text).not.toContain(memory.text)
    expect(repair.text).toContain(warning.text)
    const repaired = RuntimeAdvisory.message({
      id: "msg_repair",
      partID: "prt_repair",
      created: 3,
      root,
      observation: repair,
    })
    expect(
      RuntimeAdvisory.prepare({ scope: "a", sources, previous: RuntimeAdvisory.history([changed, repaired]) }),
    ).toBeUndefined()

    const projection = await MessageV2.projectModelMessages([original])
    const index = ContextUsage.sourceIndex({
      messages: projection.messages,
      system: [],
      provenance: projection.provenance,
    })
    expect(index.map((source) => source.source)).toContain("memory")
    expect(index.map((source) => source.source)).toContain("git-health")
    expect(index.some((source) => source.source === "userMessages")).toBe(false)
    expect(index.reduce((total, source) => total + source.characters, 0)).toBe(first.text.length)
  })

  test("legacy observation metadata upgrades without changing retained text evidence", () => {
    const value = {
      role: "user",
      origin: RuntimeAdvisory.origin,
      metadata: {
        retained: true,
        runtimeContext: {
          version: 1,
          scope: "a",
          role: "user",
          contentHash: "original",
          sources: [{ id: "memory:library", state: "present", revision: "original-revision", annotation: "retained" }],
        },
      },
    }
    const key = ["sessions", "scope", "session", "messages", "message", "info"]
    expect(upgradeRuntimeContextRecord(key, value)).toBe(true)
    expect(value.metadata.runtimeContext).toMatchObject({
      version: 2,
      contentHash: "original",
      sources: [{ kind: "state", revision: "original-revision", annotation: "retained" }],
    })
    expect(value.metadata.retained).toBe(true)
    expect(upgradeRuntimeContextRecord(key, value)).toBe(false)
  })
})
