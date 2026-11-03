import { afterAll, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentCall } from "../../src/agent/call"
import { Bus } from "../../src/bus"
import { SessionEvent } from "../../src/session/event"
import { SessionRecords } from "../../src/session/records"
import { independentExecutionInfo } from "../../src/session/types"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { Token } from "../../src/util/token"
import { SessionLongTermMemory } from "../../src/session/long-term-memory"
import { MessageV2 } from "../../src/session/message-v2"
import { PartContent } from "../../src/session/part-content"
import { SessionNav } from "../../src/session/nav"
import { SessionHistory } from "../../src/session/history"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { RolloutMigration } from "../../src/session/rollout/migration"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

const model: Provider.Model = {
  id: "memory-model",
  providerID: "test",
  name: "Memory model",
  api: { id: "memory-model", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

async function root(sessionID: string, text: string, created: number) {
  const user: MessageV2.User = {
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created },
    agent: "synergy",
    isRoot: true,
    model: { providerID: model.providerID, modelID: model.id },
  }
  await Session.updateMessage(user)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: user.id,
    type: "text",
    text,
  })
  return user
}

function progressKey(session: Session.Info) {
  return StoragePath.sessionLongTermMemory(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id))
}

function update(user: MessageV2.User, options: Partial<Parameters<typeof SessionLongTermMemory.update>[0]> = {}) {
  return SessionLongTermMemory.update({
    sessionID: user.sessionID,
    user,
    fallbackModel: model,
    signal: new AbortController().signal,
    ...options,
  })
}

async function withSession(fn: (session: Session.Info) => Promise<void>) {
  return runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        using agentModel = spyOn(Agent, "getAvailableModel").mockResolvedValue(undefined)
        try {
          await fn(session)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })
}

async function assistant(user: MessageV2.User, text: string, created: number, summary = false) {
  const info: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    sessionID: user.sessionID,
    role: "assistant",
    parentID: user.id,
    rootID: user.id,
    time: { created, completed: created + 1 },
    modelID: model.id,
    providerID: model.providerID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    summary,
  }
  await Session.updateMessage(info)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: user.sessionID,
    messageID: info.id,
    type: "text",
    text,
  })
  return info
}

async function observation(info: MessageV2.Assistant, output: string, callID = "evidence-call") {
  const part: MessageV2.ToolPart = {
    id: Identifier.ascending("part"),
    sessionID: info.sessionID,
    messageID: info.id,
    type: "tool",
    tool: "read",
    callID,
    state: {
      status: "completed",
      input: { path: "source.txt" },
      output,
      title: "Read original",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
  return Session.updatePart(part)
}

for (const mutation of ["edited prefix", "deleted prefix", "inserted prefix", "deleted anchor"] as const) {
  test(`rebuilds reviewed original lineage after an ${mutation} between updates`, () =>
    withSession(async (session) => {
      const first = await root(session.id, "Original topic A", 1)
      const anchor = await root(session.id, "Original topic B", 2)
      using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Stale summary of A and B", model })
      await update(anchor)
      if (mutation === "edited prefix") {
        const [part] = (await MessageV2.get({ sessionID: session.id, messageID: first.id })).parts
        if (!part || part.type !== "text") throw new Error("Expected original text")
        await Session.updatePart({ ...part, text: "Corrected topic A" })
      } else if (mutation === "inserted prefix") {
        await root(session.id, "Backdated original topic", 1.5)
      } else {
        await Session.removeMessage({
          sessionID: session.id,
          messageID: mutation === "deleted anchor" ? anchor.id : first.id,
        })
      }
      const latest = await root(session.id, "Current topic C", 3)
      call.mockImplementation(async (input) => {
        const text = JSON.stringify(input.messages)
        expect(text).not.toContain("Stale summary")
        expect(text).toContain("Current topic C")
        expect(text).toContain(
          mutation === "edited prefix"
            ? "Corrected topic A"
            : mutation === "inserted prefix"
              ? "Backdated original topic"
              : mutation === "deleted anchor"
                ? "Original topic A"
                : "Original topic B",
        )
        if (mutation === "edited prefix" || mutation === "deleted prefix")
          expect(text).not.toContain("Original topic A")
        if (mutation === "deleted anchor") expect(text).not.toContain("Original topic B")
        return { text: "# Rebuilt from current originals", model }
      })
      await update(latest)
      expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Rebuilt from current originals")
      expect((await SessionLongTermMemory.progress(await Session.get(session.id)))?.reviewedThrough).toEqual(
        SessionLongTermMemory.cursor(latest),
      )
    }))
}

for (const invalidation of ["edited originals", "unproven legacy progress"] as const) {
  test(`retires stale memory before a failed rebuild of ${invalidation}`, () =>
    withSession(async (session) => {
      const first = await root(session.id, "Earlier original evidence", 1)
      using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Untrusted previous summary", model })
      await update(first)
      if (invalidation === "edited originals") {
        const [part] = (await MessageV2.get({ sessionID: session.id, messageID: first.id })).parts
        if (!part || part.type !== "text") throw new Error("Expected original text")
        await Session.updatePart({ ...part, text: "Corrected original evidence" })
      } else {
        await Storage.write(
          StoragePath.sessionLongTermMemory(Identifier.asScopeID(session.scope.id), Identifier.asSessionID(session.id)),
          {
            reviewedThrough: SessionLongTermMemory.cursor(first),
          },
        )
      }
      const latest = await root(session.id, "New original evidence", 2)
      const before = await Session.get(session.id)
      call.mockImplementation(async (input) => {
        expect(JSON.stringify(input.messages)).not.toContain("Untrusted previous summary")
        throw new Error("Original evidence rebuild failed")
      })
      await expect(update(latest)).rejects.toThrow("Original evidence rebuild failed")
      const failed = await Session.get(session.id)
      expect(failed.longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(failed)).toBeUndefined()
      expect(failed.time).toEqual(before.time)
      call.mockResolvedValue({ text: "# Rebuilt original evidence", model })
      await update(latest)
      expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Rebuilt original evidence")
      expect((await SessionLongTermMemory.progress(await Session.get(session.id)))?.reviewedThrough).toEqual(
        SessionLongTermMemory.cursor(latest),
      )
    }))
}

for (const mode of ["compact", "compacted"] as const) {
  test(`refuses imported ${mode} tool previews as original evidence`, () =>
    withSession(async (session) => {
      const user = await root(session.id, "Review imported original evidence", 1)
      const response = await assistant(user, "Completed observation", 2)
      const tool = await observation(response, "Complete original evidence.\n".repeat(300))
      if (mode === "compacted" && tool.type === "tool" && tool.state.status === "completed")
        await Session.updatePart({ ...tool, state: { ...tool.state, time: { ...tool.state.time, compacted: 3 } } })
      const report = await SessionExport.generate({ sessionID: session.id, mode: "compact" })
      const imported = await SessionImport.fromReport(report)
      try {
        using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Incorrect preview memory", model })
        await expect(update({ ...user, sessionID: imported.rootSessionID })).rejects.toThrow(
          "Original tool output is unavailable",
        )
        expect(call).not.toHaveBeenCalled()
        expect((await Session.get(imported.rootSessionID)).longTermMemory).toBeUndefined()
        expect(await SessionLongTermMemory.progress(await Session.get(imported.rootSessionID))).toBeUndefined()
      } finally {
        await Session.remove(imported.rootSessionID)
      }
    }))
}

for (const origin of [
  "legacy",
  "owner preparation",
  "write",
  "import",
  "existing preview artifact",
  "known missing original",
] as const) {
  test(`refuses truncated tool output without complete original evidence after ${origin}`, () =>
    withSession(async (session) => {
      const user = await root(session.id, "Review the actual original tool output", 1)
      const response = await assistant(user, "Recorded a bounded observation", 2)
      const state: MessageV2.ToolStateCompleted = {
        status: "completed",
        input: { path: "source.txt" },
        output: "Only a bounded preview remains.",
        outputTruncated: true,
        title: "Bounded observation",
        metadata: {},
        time: { start: 1, end: 2 },
      }
      const part: MessageV2.ToolPart = {
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: response.id,
        type: "tool",
        tool: "read",
        callID: "truncated-evidence",
        state,
      }
      let target = session.id
      if (origin === "known missing original") {
        state.outputTruncated = undefined
        state.metadata.rolloutLegacyOutput = "missing"
      }
      if (origin === "existing preview artifact" || origin === "known missing original") {
        if (origin === "existing preview artifact") state.outputBytes = 20_000
        state.outputArtifact = await RolloutArtifact.writeText(
          { kind: "session", scopeID: session.scope.id, sessionID: session.id },
          state.output,
        )
      }
      if (
        origin === "legacy" ||
        origin === "owner preparation" ||
        origin === "existing preview artifact" ||
        origin === "known missing original"
      ) {
        await Storage.write(
          StoragePath.messagePart(
            Identifier.asScopeID(session.scope.id),
            Identifier.asSessionID(session.id),
            Identifier.asMessageID(response.id),
            Identifier.asPartID(part.id),
          ),
          part,
        )
      } else if (origin === "write") await Session.updatePart(part)
      else {
        const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
        report.sessions[0]!.messages.find((message) => message.info.id === response.id)!.parts.push(part)
        target = (await SessionImport.fromReport(report)).rootSessionID
      }
      if (origin === "owner preparation")
        await RolloutMigration.session({ kind: "session", scopeID: session.scope.id, sessionID: session.id })
      try {
        using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Incorrect bounded observation", model })
        await expect(update({ ...user, sessionID: target })).rejects.toThrow("Original tool output is unavailable")
        expect(call).not.toHaveBeenCalled()
        expect((await Session.get(target)).longTermMemory).toBeUndefined()
        expect(await SessionLongTermMemory.progress(await Session.get(target))).toBeUndefined()
      } finally {
        if (target !== session.id) await Session.remove(target)
      }
    }))
}

for (const provenance of ["retained", "restored"] as const) {
  test(`reviews a bounded canonical tool preview from its ${provenance} complete original artifact`, () =>
    withSession(async (session) => {
      const user = await root(session.id, "Review all retained original bytes", 1)
      const response = await assistant(user, "Retained the original observation", 2)
      const original = "Complete original evidence with Unicode: café.\n".repeat(1200)
      const tool = await observation(response, original)
      if (tool.type !== "tool" || tool.state.status !== "completed") throw new Error("Expected completed observation")
      expect(tool.state.outputTruncated).toBe(true)
      expect(tool.state.outputArtifact?.bytes).toBe(Buffer.byteLength(original, "utf8"))
      if (provenance === "restored")
        await Session.updatePart({
          ...tool,
          state: {
            ...tool.state,
            metadata: {
              ...tool.state.metadata,
              rolloutLegacyOutput: "missing",
              rolloutImportMissingOutput: tool.state.outputArtifact,
            },
          },
        })
      using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
        const reviewed = input.messages.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result" && part.output.type === "text" ? [part.output.value] : [],
              )
            : [],
        )
        expect(reviewed.join("")).toBe(original)
        return { text: "# Complete original evidence", model }
      })
      await update(user)
      expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Complete original evidence")
      const persisted = (await MessageV2.get({ sessionID: session.id, messageID: response.id })).parts.find(
        (part) => part.id === tool.id,
      )
      if (persisted?.type !== "tool" || persisted.state.status !== "completed")
        throw new Error("Expected persisted observation")
      expect(persisted.state.outputTruncated).toBe(true)
      expect(persisted.state.output).not.toBe(original)
    }))
}

test("repeated transcript imports cannot replace missing-original provenance with a preview artifact", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Keep original provenance across imports", 1)
    const response = await assistant(user, "Completed original observation", 2)
    await observation(response, "Original observation must not become a preview.\n".repeat(300))
    const first = await SessionImport.fromReport(
      await SessionExport.generate({ sessionID: session.id, mode: "compact" }),
    )
    const second = await SessionImport.fromReport(
      await SessionExport.generate({ sessionID: first.rootSessionID, mode: "full" }),
    )
    try {
      using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Laundered preview", model })
      await expect(update({ ...user, sessionID: second.rootSessionID })).rejects.toThrow(
        "Original tool output is unavailable",
      )
      expect(call).not.toHaveBeenCalled()
      expect(await SessionLongTermMemory.progress(await Session.get(second.rootSessionID))).toBeUndefined()
    } finally {
      await Session.remove(first.rootSessionID)
      await Session.remove(second.rootSessionID)
    }
  }))

test("validates byte-exact full inline tool originals after transcript import", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Review full imported observation", 1)
    const response = await assistant(user, "Completed observation", 2)
    const original = "Complete original tool evidence with Unicode: café."
    await observation(response, original)
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    const tool = report.sessions[0]!.messages.flatMap((message) => message.parts).find((part) => part.type === "tool")
    if (tool?.type !== "tool" || tool.state.status !== "completed")
      throw new Error("Expected full imported observation")
    tool.state.outputTruncated = true
    const imported = await SessionImport.fromReport(report)
    try {
      using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
        expect(JSON.stringify(input.messages)).toContain(original)
        return { text: "# Validated original evidence", model }
      })
      await update({ ...user, sessionID: imported.rootSessionID })
      expect((await Session.get(imported.rootSessionID)).longTermMemory?.markdown).toBe("# Validated original evidence")
    } finally {
      await Session.remove(imported.rootSessionID)
    }
  }))

test("reviews completed observations on failed assistants without changing ordinary replay", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Remember observed facts", 1)
    const response = await assistant(user, "Completed before later provider failure", 2)
    const original = "The actual tool observed a durable project fact."
    await observation(response, original)
    await Session.updateMessage({
      ...response,
      error: MessageV2.fromError(new Error("Later provider failure"), { providerID: model.providerID }),
    })
    const ordinary = await MessageV2.projectModelMessages(
      await SessionHistory.originalMessages({ sessionID: session.id }),
    )
    expect(JSON.stringify(ordinary.messages)).not.toContain(original)
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      expect(JSON.stringify(input.messages)).toContain(original)
      return { text: "# Observed project fact", model }
    })
    await update(user)
    expect((await MessageV2.get({ sessionID: session.id, messageID: response.id })).info).toHaveProperty("error")
  }))

test("normalizes authoritative native tool outcomes before evidence grouping", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Keep the execution outcome", 1)
    const response = await assistant(user, "Executed original observation", 2)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: response.id,
      type: "tool",
      tool: "read",
      callID: "shared-call",
      state: {
        status: "error",
        input: { path: "source.txt" },
        error: "Synthetic SDK error is not the execution outcome",
        metadata: { toolDiagnostic: { metadata: { source: "ai_sdk_tool_error" } } },
        time: { start: 1, end: 2 },
      },
    })
    const original = "Authoritative successful execution observation"
    await observation(response, original, "shared-call")
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      const calls = input.messages.flatMap((message) =>
        message.role === "assistant" && Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "tool-call" && part.toolCallId === "shared-call")
          : [],
      )
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(input.messages)).toContain(original)
      expect(JSON.stringify(input.messages)).not.toContain("Synthetic SDK error")
      return { text: "# Authoritative observation", model }
    })
    await update(user)
  }))

test("reads original evidence behind compaction, excludes controls, and honors an inclusive through cursor", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Original early decision", 1)
    await assistant(first, "Derived compaction summary must not be reviewed", 2, true)
    const attempt = await assistant(first, "Failed compaction attempt must not be reviewed", 2.5)
    await Session.updateMessage({ ...attempt, mode: "compaction", summary: false, includeInContext: false })
    const control = await root(session.id, "Runtime advisory must not be reviewed", 3)
    await Session.updateMessage({ ...control, origin: { type: "system", detail: "runtime-context" }, isRoot: false })
    const last = await root(session.id, "Original latest decision", 4)
    await root(session.id, "Future evidence must wait", 5)
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      const content = JSON.stringify(input.messages)
      expect(content).toContain("Original early decision")
      expect(content).toContain("Original latest decision")
      expect(content).not.toContain("Derived compaction summary")
      expect(content).not.toContain("Failed compaction attempt")
      expect(content).not.toContain("Runtime advisory")
      expect(content).not.toContain("Future evidence")
      return { text: "# Original decisions\n", model }
    })
    await update(last, { through: SessionLongTermMemory.cursor(last) })
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(last),
    })
  }))

test("manual compaction controls do not trigger review or advance the original evidence anchor", () =>
  withSession(async (session) => {
    const original = await root(session.id, "Durable original before manual compaction", 1)
    const markdown = "# Durable original decisions"
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(original)
    const before = (await Session.get(session.id)).longTermMemory
    const control = await root(session.id, "What did we do so far?", 2)
    await Session.updateMessage({ ...control, metadata: { compactionBoundary: true } })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: control.id,
      type: "compaction",
      auto: false,
    })
    const [canonical] = MessageV2.deriveSemantics([
      await MessageV2.get({ sessionID: session.id, messageID: control.id }),
    ])
    expect(SessionLongTermMemory.isSourceMessage(canonical!)).toBe(false)
    await update(control)
    expect(call).toHaveBeenCalledTimes(1)
    expect((await Session.get(session.id)).longTermMemory).toEqual(before)
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(original),
    })
    const fork = await Session.fork({ sessionID: session.id })
    try {
      await update({ ...control, sessionID: fork.id })
      expect(call).toHaveBeenCalledTimes(1)
      expect((await Session.get(fork.id)).longTermMemory).toEqual(before)
    } finally {
      await Session.remove(fork.id)
    }
  }))

test("real user questions remain evidence when automatic compaction shares their root", () =>
  withSession(async (session) => {
    const user = await root(session.id, "What did we do so far?", 1)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: user.id,
      type: "compaction",
      auto: true,
    })
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      expect(JSON.stringify(input.messages)).toContain("What did we do so far?")
      return { text: "# Actual user question", model }
    })
    await update(user)
    expect(call).toHaveBeenCalledTimes(1)
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(user),
    })
  }))

for (const mutation of [
  "part edit",
  "new part",
  "backdated message",
  "header chronology",
  "source exclusion",
  "rollback",
  "delete",
] as const) {
  test(`rejects stale publication after a concurrent ${mutation}`, () =>
    withSession(async (session) => {
      const user = await root(session.id, "Initial source", 2)
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      using call = spyOn(AgentCall, "text").mockImplementation(async () => {
        started.resolve()
        await resume.promise
        return { text: "# Stale memory", model }
      })
      const pending = update(user)
      const settled = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      await started.promise
      try {
        if (mutation === "part edit") {
          const message = await MessageV2.get({ sessionID: session.id, messageID: user.id })
          const part = message.parts[0]!
          if (part.type !== "text") throw new Error("Expected source text")
          await Session.updatePart({ ...part, text: "Edited source" })
        } else if (mutation === "new part") {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: user.id,
            type: "text",
            text: "New source",
          })
        } else if (mutation === "backdated message") {
          await root(session.id, "Inserted earlier source", 1)
        } else if (mutation === "header chronology") {
          await Session.updateMessage({ ...user, time: { created: 1 } })
        } else if (mutation === "source exclusion") {
          await Session.updateMessage({ ...user, includeInContext: false })
        } else if (mutation === "rollback") {
          await Session.rollback({ sessionID: session.id, numTurns: 1 })
        } else {
          await Session.remove(session.id)
        }
      } finally {
        resume.resolve()
      }
      const error = await settled
      expect(error).toBeInstanceOf(Error)
      if (mutation !== "delete") {
        expect(error).toBeInstanceOf(SessionLongTermMemory.ConflictError)
        expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
        expect(await Storage.readMany([progressKey(session)])).toEqual([undefined])
      }
    }))
}

test("review progress CAS rejects a delayed no-change result even when the Markdown revision is unchanged", () =>
  withSession(async (session) => {
    const first = await root(session.id, "First source", 1)
    const markdown = "# Retained\n"
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(first)
    const second = await root(session.id, "Second source", 2)
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    call.mockImplementationOnce(async () => {
      started.resolve()
      await resume.promise
      return { text: markdown, model }
    })
    const delayed = update(second)
    const settled = delayed.then(
      () => undefined,
      (error: unknown) => error,
    )
    await started.promise
    try {
      await update(second)
    } finally {
      resume.resolve()
    }
    expect(await settled).toBeInstanceOf(SessionLongTermMemory.ConflictError)
    expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(second),
    })
  }))

test("retains complete Markdown within native model capacity without a separate character ceiling", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Review important history without an arbitrary character cap.", 1)
    const markdown = `# Complete session record\n\n${"Important outcome and its decision reason.\n".repeat(2_000)}`
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      expect(input.maxOutputTokens).toBe(model.limit.output)
      expect(input.maxOutputChars).toBeGreaterThan(markdown.length)
      return { text: markdown, model }
    })
    await update(user)
    expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
  }))

for (const outcome of ["failure", "cancellation", "incomplete output"] as const) {
  test(`keeps both memory and review progress unchanged after ${outcome}`, () =>
    withSession(async (session) => {
      const first = await root(session.id, "First source", 1)
      const markdown = "# Existing\n\nKeep trailing spaces.  \n"
      using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
      await update(first)
      const previous = await SessionLongTermMemory.progress(await Session.get(session.id))
      const second = await root(session.id, "Second source", 2)
      const abort = new AbortController()
      call.mockImplementation(async () => {
        if (outcome === "failure") throw new Error("Provider failure")
        if (outcome === "cancellation") abort.abort()
        if (outcome === "incomplete output") throw new AgentCall.Error("incomplete_output", "Length stop")
        return { text: "# Cancelled output", model }
      })
      await expect(update(second, { signal: abort.signal })).rejects.toThrow()
      expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
      expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toEqual(previous)
    }))
}

test("full forks remap the review cursor while historical forks never inherit future memory", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Earlier task", 1)
    const last = await root(session.id, "Future task", 2)
    const markdown = "# Both tasks\n"
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(last)
    const events = new Map<string, Session.Info>()
    using subscription = {
      [Symbol.dispose]: Bus.subscribe(SessionEvent.Updated, (event) => {
        events.set(event.properties.info.id, event.properties.info)
      }),
    }
    const full = await Session.fork({ sessionID: session.id })
    const historical = await Session.fork({ sessionID: session.id, position: { type: "through", messageID: first.id } })
    try {
      expect(full.longTermMemory).toEqual({ markdown, revision: 1 })
      const copied = (await Session.messages({ sessionID: full.id })).at(-1)!
      expect(copied.info.id).not.toBe(last.id)
      const copiedProgress = await SessionLongTermMemory.progress(await Session.get(full.id))
      expect(copiedProgress).toMatchObject({
        reviewedThrough: { created: 2, messageID: copied.info.id },
        source: { version: 1 },
      })
      expect(copiedProgress?.source?.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(await SessionLongTermMemory.isCurrent(await Session.get(full.id), copiedProgress!)).toBe(true)
      expect(events.get(full.id)).toHaveProperty("longTermMemoryReview", {
        reviewedThrough: { created: 2, messageID: copied.info.id },
      })
      expect(events.get(historical.id)).not.toHaveProperty("longTermMemoryReview")
      expect(historical.longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(await Session.get(historical.id))).toBeUndefined()
      await update({ ...last, id: copied.info.id, sessionID: full.id })
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      await Session.remove(full.id)
      await Session.remove(historical.id)
    }
  }))

test("rollback and unrollback invalidate both memory and review progress before rebuilding effective history", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Retained original", 1)
    const last = await root(session.id, "Undone original", 2)
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Both originals", model })
    await update(last)
    const rollback = await Session.rollback({ sessionID: session.id, numTurns: 1 })
    expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toBeUndefined()
    call.mockImplementation(async (input) => {
      expect(JSON.stringify(input.messages)).toContain("Retained original")
      expect(JSON.stringify(input.messages)).not.toContain("Undone original")
      return { text: "# Retained original", model }
    })
    await update(first)
    expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Retained original")
    if (!rollback || !("id" in rollback)) throw new Error("Expected rollback event")
    await Session.unrollback({ sessionID: session.id, rollbackID: rollback.id })
    expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toBeUndefined()
  }))

test("transcript round trips keep aligned review progress and discard a missing original anchor", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Exported original", 1)
    const markdown = "# Exported knowledge\n"
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(user)
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    expect(report.sessions[0]?.longTermMemoryProgress).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(user),
      source: { version: 1 },
    })
    expect(report.sessions[0]?.info).not.toHaveProperty("longTermMemoryReview")
    Object.assign(report.sessions[0]!.info, {
      longTermMemoryReview: { reviewedThrough: { created: 999, messageID: Identifier.ascending("message") } },
    })
    const parsed = SessionImport.parse(new TextEncoder().encode(JSON.stringify(report)))
    expect(parsed.sessions[0]?.info).not.toHaveProperty("longTermMemoryReview")
    const result = await SessionImport.fromReport(parsed)
    const imported = await Session.get(result.rootSessionID)
    try {
      expect(imported.longTermMemory).toEqual({ markdown, revision: 1 })
      const importedProgress = await SessionLongTermMemory.progress(imported)
      expect(importedProgress).toMatchObject({
        reviewedThrough: SessionLongTermMemory.cursor(user),
        source: { version: 1 },
      })
      expect(await SessionLongTermMemory.isCurrent(imported, importedProgress!)).toBe(true)
      await update({ ...user, sessionID: imported.id })
      expect(call).toHaveBeenCalledTimes(1)
    } finally {
      await Session.remove(imported.id)
    }
    report.sessions[0]!.messages = []
    const invalid = await SessionImport.fromReport(report)
    try {
      expect((await Session.get(invalid.rootSessionID)).longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(await Session.get(invalid.rootSessionID))).toBeUndefined()
    } finally {
      await Session.remove(invalid.rootSessionID)
    }
  }))

test("legacy control anchors discard memory progress without blocking transcript import", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Retained imported original", 1)
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Imported knowledge", model })
    await update(user)
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    const controlID = Identifier.ascending("message")
    const control: MessageV2.WithParts = {
      info: {
        ...user,
        id: controlID,
        rootID: controlID,
        time: { created: 2 },
        origin: { type: "user" },
        metadata: { compactionBoundary: true },
      },
      parts: [
        {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: controlID,
          type: "compaction",
          auto: false,
        },
        {
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: controlID,
          type: "text",
          text: "What did we do so far?",
          origin: "user",
        },
      ],
    }
    const data = report.sessions[0]!
    data.messages.push(control)
    data.longTermMemoryProgress!.reviewedThrough = SessionLongTermMemory.cursor(control.info)
    const imported = await SessionImport.fromReport(report)
    try {
      const stored = await Session.get(imported.rootSessionID)
      expect(stored.longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(stored)).toBeUndefined()
      const messages = await Session.messages({ sessionID: stored.id })
      expect(JSON.stringify(messages)).toContain("Retained imported original")
      expect(JSON.stringify(messages)).toContain("What did we do so far?")
    } finally {
      await Session.remove(imported.rootSessionID)
    }
  }))

test("raw transcript import cannot retain progress that skipped rolled-back source history", () =>
  withSession(async (session) => {
    await root(session.id, "Retained topic A", 1)
    await root(session.id, "Rolled-back topic B", 2)
    await Session.rollback({ sessionID: session.id, numTurns: 1 })
    const latest = await root(session.id, "Later topic C", Date.now() + 1)
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      expect(JSON.stringify(input.messages)).toContain("Later topic C")
      expect(JSON.stringify(input.messages)).not.toContain("Rolled-back topic B")
      return { text: "# Topics A and C", model }
    })
    await update(latest)
    expect((await SessionLongTermMemory.progress(await Session.get(session.id)))?.reviewedThrough).toEqual(
      SessionLongTermMemory.cursor(latest),
    )
    const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
    expect(JSON.stringify(report.sessions[0]?.messages)).toContain("Rolled-back topic B")
    expect(report.sessions[0]?.longTermMemoryProgress).toBeUndefined()
    expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Topics A and C")
    const imported = await SessionImport.fromReport(report)
    try {
      expect((await Session.get(imported.rootSessionID)).longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(await Session.get(imported.rootSessionID))).toBeUndefined()
      call.mockImplementation(async (input) => {
        expect(JSON.stringify(input.messages)).toContain("Rolled-back topic B")
        return { text: "# Restored raw topics", model }
      })
      await update({ ...latest, sessionID: imported.rootSessionID })
      expect(call).toHaveBeenCalledTimes(2)
    } finally {
      await Session.remove(imported.rootSessionID)
    }
  }))

test("original history retains the canonical Part order for tied identifier prefixes", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Original order", 1)
    const prefix = Identifier.ascending("part").slice(0, -1)
    for (const suffix of ["A", "a"]) {
      await Session.updatePart({
        id: prefix + suffix,
        sessionID: session.id,
        messageID: user.id,
        type: "text",
        text: suffix,
      })
    }
    const canonical = await MessageV2.parts({ sessionID: session.id, messageID: user.id })
    const original = await SessionHistory.originalMessages({ sessionID: session.id })
    expect(original[0]?.parts.map((part) => part.id)).toEqual(canonical.map((part) => part.id))
  }))

test("header bookkeeping before and during review preserves original lineage", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Already reviewed original body ".repeat(1000), 1)
    const markdown = "# Retained session decisions"
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(first)
    await Session.updateMessage({ ...first, metadata: { runtimeContextTimeRecorded: true } })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: first.id,
      type: "compaction",
      auto: true,
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: first.id,
      type: "text",
      origin: "system",
      text: "Injected control bookkeeping",
    })
    const advisory = await root(session.id, "Runtime advisory bookkeeping", 0.5)
    await Session.updateMessage({ ...advisory, isRoot: false, origin: { type: "system", detail: "runtime-context" } })
    const control = { ...first, id: Identifier.ascending("message"), time: { created: 0.75 }, isRoot: false }
    await Session.updateMessage(control)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: control.id,
      type: "compaction",
      auto: true,
    })
    const existingProgress = await SessionLongTermMemory.progress(await Session.get(session.id))
    expect(await SessionLongTermMemory.isCurrent(await Session.get(session.id), existingProgress!)).toBe(true)
    const latest = await root(session.id, "New original evidence", 2)
    using parts = spyOn(PartContent, "hydrate")
    call.mockImplementation(async (input) => {
      expect(JSON.stringify(input.messages)).toContain(markdown)
      expect(JSON.stringify(input.messages)).not.toContain("Already reviewed original body")
      expect(JSON.stringify(input.messages)).not.toContain("Runtime advisory bookkeeping")
      await Session.updateMessage({ ...latest, summary: { title: "Derived topic title", diffs: [] } })
      return { text: markdown, model }
    })
    await update(latest)
    expect(parts.mock.calls.map(([key]) => key[4])).toEqual([latest.id])
  }))

test("uses the largest remaining native output allowance when full output reservation excludes valid old Markdown", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Record a substantial session memory", 1)
    const markdown = `# Existing session knowledge\n\n${"Keep this durable decision.\n".repeat(800)}`
    const target = { ...model, limit: { context: 16_384, output: 12_288 } }
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model: target })
    await update(first, { fallbackModel: target })
    const latest = await root(session.id, "One small additional fact", 2)
    const minimumOutput = await Token.estimateModel(target.id, markdown)
    call.mockImplementation(async (input) => {
      expect(input.maxOutputTokens).toBeLessThan(target.limit.output)
      expect(input.maxOutputTokens).toBeGreaterThanOrEqual(minimumOutput)
      expect(JSON.stringify(input.messages)).toContain("Existing session knowledge")
      expect(JSON.stringify(input.messages)).toContain("One small additional fact")
      return { text: markdown, model: target }
    })
    await update(latest, { fallbackModel: target })
    expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
    expect((await SessionLongTermMemory.progress(await Session.get(session.id)))?.reviewedThrough).toEqual(
      SessionLongTermMemory.cursor(latest),
    )
  }))

test("does not overwrite memory or progress when existing Markdown genuinely cannot fit a complete rewrite", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Original evidence", 1)
    const markdown = `# Existing knowledge\n${"Keep this durable decision.\n".repeat(800)}`
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: markdown, model })
    await update(first)
    const previous = await SessionLongTermMemory.progress(await Session.get(session.id))
    const latest = await root(session.id, "New evidence", 2)
    await expect(
      update(latest, { fallbackModel: { ...model, limit: { context: 4096, output: 3072 } } }),
    ).rejects.toThrow("context window")
    expect(call).toHaveBeenCalledTimes(1)
    expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toEqual(previous)
  }))

test("incremental review does not hydrate already-reviewed original bodies", () =>
  withSession(async (session) => {
    const first = await root(session.id, "Large reviewed material ".repeat(2000), 1)
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Reviewed", model })
    await update(first)
    const second = await root(session.id, "New material", 2)
    using parts = spyOn(PartContent, "hydrate")
    await update(second)
    expect(parts.mock.calls.map(([key]) => key[4])).toEqual([second.id])
  }))

test("segments oversized native text without dropping source characters or publishing intermediate memory", () =>
  withSession(async (session) => {
    const text = Array.from({ length: 2500 }, (_, index) => `line-${index}: retain original evidence.\n`).join("")
    const user = await root(session.id, text, 1)
    const smallModel = { ...model, limit: { context: 8192, output: 2048 } }
    const reviewed: string[] = []
    let calls = 0
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      calls++
      expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
      expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toBeUndefined()
      for (const message of input.messages.slice(1, -1)) {
        if (message.role !== "user") continue
        if (typeof message.content === "string") reviewed.push(message.content)
        else for (const part of message.content) if (part.type === "text") reviewed.push(part.text)
      }
      return { text: `# Reviewed segment ${calls}\n`, model: smallModel }
    })
    await update(user, { fallbackModel: smallModel })
    expect(calls).toBeGreaterThan(1)
    expect(reviewed.join("")).toBe(text)
    expect((await Session.get(session.id)).longTermMemory).toEqual({
      markdown: `# Reviewed segment ${calls}\n`,
      revision: 1,
    })
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toMatchObject({
      reviewedThrough: SessionLongTermMemory.cursor(user),
    })
  }))

test("native review preserves media and original compacted tool results without provider continuation metadata", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Review attached evidence", 1)
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: user.id,
      type: "attachment",
      mime: "image/png",
      url: image,
      model: { mode: "provider-file", summary: "Original evidence image" },
    })
    const response = await assistant(user, "Observed the tool result", 2)
    const original = "Original retained tool evidence"
    const artifact = await RolloutArtifact.writeText(
      { kind: "session", scopeID: session.scope.id, sessionID: session.id },
      original,
    )
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: response.id,
      type: "tool",
      tool: "read",
      callID: "retained-call",
      metadata: { openai: { itemId: "source-provider-item", reasoningEncryptedContent: "opaque-source-reasoning" } },
      state: {
        status: "completed",
        input: { path: "source.txt" },
        output: "",
        outputArtifact: artifact,
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2, compacted: 3 },
      },
    })
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      const serialized = JSON.stringify(input.messages)
      expect(serialized).toContain(original)
      expect(serialized).not.toContain("Old tool result content cleared")
      expect(serialized).not.toContain("source-provider-item")
      expect(serialized).not.toContain("opaque-source-reasoning")
      expect(input.messages.some((message) => message.role === "tool")).toBe(true)
      expect(
        input.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "file" && part.mediaType === "image/png"),
        ),
      ).toBe(true)
      return { text: "# Recorded original evidence", model }
    })
    await update(user)
    const retained = await MessageV2.get({ sessionID: session.id, messageID: response.id })
    expect(
      retained.parts.some(
        (part) => part.type === "tool" && part.state.status === "completed" && part.state.time.compacted === 3,
      ),
    ).toBe(true)
  }))

for (const outcome of ["completed", "error"] as const) {
  test(`losslessly segments normalized native ${outcome} tool observations`, () =>
    withSession(async (session) => {
      const user = await root(session.id, "Review the complete tool observation", 1)
      const response = await assistant(user, "Observed tool evidence", 2)
      const original = "Retain every recorded tool observation.\n".repeat(2200)
      if (outcome === "completed") await observation(response, original)
      else
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: response.id,
          type: "tool",
          tool: "read",
          callID: "error-evidence",
          state: {
            status: "error",
            input: { path: "source.txt" },
            error: original,
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
      const reviewed: string[] = []
      using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
        for (const message of input.messages) {
          if (message.role !== "tool") continue
          for (const part of message.content)
            if (part.type === "tool-result" && (part.output.type === "text" || part.output.type === "error-text"))
              reviewed.push(part.output.value)
        }
        return { text: "# Reviewed complete observations", model }
      })
      await update(user, { fallbackModel: { ...model, limit: { context: 8192, output: 2048 } } })
      expect(reviewed.length).toBeGreaterThan(1)
      expect(reviewed.join("")).toBe(original)
    }))
}

test("prepares missing legacy execution metadata once without rereading reviewed bodies on the next update", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Legacy original evidence", 1)
    const [part] = (await MessageV2.get({ sessionID: session.id, messageID: user.id })).parts
    await Storage.update<Record<string, unknown>>(
      StoragePath.sessionDisplayPart(session.scope.id, session.id, user.id, part!.id),
      (draft) => {
        delete draft.execution
      },
    )
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Reviewed originals", model })
    await update(user)
    const latest = await root(session.id, "New original evidence", 2)
    using hydrated = spyOn(PartContent, "hydrate")
    await update(latest)
    expect(hydrated.mock.calls.map(([key]) => key[4])).toEqual([latest.id])
    expect(call).toHaveBeenCalledTimes(2)
  }))

test("does not publish a successful first segment when a later segment fails", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Original material must be completely reviewed.\n".repeat(3000), 1)
    let calls = 0
    using call = spyOn(AgentCall, "text").mockImplementation(async () => {
      calls++
      if (calls === 2) throw new Error("Later segment failed")
      return { text: "# Intermediate memory", model }
    })
    await expect(update(user, { fallbackModel: { ...model, limit: { context: 8192, output: 2048 } } })).rejects.toThrow(
      "Later segment failed",
    )
    expect(calls).toBe(2)
    expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toBeUndefined()
  }))

test("does not mark an unfinished original tool observation as reviewed", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Observe the original tool", 1)
    const response = await assistant(user, "An observation is still running", 2)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: session.id,
      messageID: response.id,
      type: "tool",
      tool: "read",
      callID: "unfinished-call",
      state: { status: "pending", input: { path: "source.txt" }, raw: "" },
    })
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "# Incomplete review", model })
    await expect(update(user)).rejects.toThrow("not complete")
    expect(call).not.toHaveBeenCalled()
    expect((await Session.get(session.id)).longTermMemory).toBeUndefined()
    expect(await SessionLongTermMemory.progress(await Session.get(session.id))).toBeUndefined()
  }))

test("matches AgentCall configured-model fallback and does not swallow model-selection failures", () =>
  withSession(async (session) => {
    const user = await root(session.id, "Model selection source", 1)
    using available = spyOn(Agent, "getAvailableModel").mockResolvedValue({ providerID: "missing", modelID: "missing" })
    using provider = spyOn(Provider, "getModel").mockRejectedValue(new Error("Configured model unavailable"))
    using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
      expect(input.model).toBe(model)
      return { text: "# Fallback memory", model }
    })
    await update(user)
    const next = await root(session.id, "New model-selection source", 2)
    const failure = new Error("Explicit model configuration failed")
    available.mockRejectedValue(failure)
    await expect(update(next)).rejects.toBe(failure)
    expect(call).toHaveBeenCalledTimes(1)
    expect((await Session.get(session.id)).longTermMemory?.markdown).toBe("# Fallback memory")
  }))

test("updates complete Markdown from original history and advances unchanged review without activity", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        await root(session.id, "Project A uses SQLite.", 1)
        const user = await root(session.id, "Project B is unrelated and uses PostgreSQL.", 2)
        using agentModel = spyOn(Agent, "getAvailableModel").mockResolvedValue(undefined)
        const markdown = "# Projects\n\n- Project A uses SQLite.\n- Project B uses PostgreSQL.\n"
        using call = spyOn(AgentCall, "text").mockImplementation(async (input) => {
          expect(Storage.inTransaction()).toBe(false)
          expect(input).toMatchObject({ agent: "session-long-term-memory", requireComplete: true })
          expect(input.maxOutputTokens).toBe(model.limit.output)
          expect(JSON.stringify(input.messages)).toContain("Project A uses SQLite.")
          expect(JSON.stringify(input.messages)).toContain("Project B is unrelated")
          return { text: markdown, model }
        })
        const before = await Session.get(session.id)
        const navBefore = (await SessionNav.readNavIndex(session.scope.id)).entries.find(
          (entry) => entry.id === session.id,
        )
        const events: Session.Info[] = []
        using subscription = {
          [Symbol.dispose]: Bus.subscribe(SessionEvent.Updated, (event) => {
            if (event.properties.info.id === session.id) events.push(event.properties.info)
          }),
        }
        await update(user)
        expect(events).toHaveLength(1)
        expect(events[0]).toHaveProperty("longTermMemoryReview", {
          reviewedThrough: { created: 2, messageID: user.id },
        })
        expect((await Session.get(session.id)).longTermMemory).toEqual({ markdown, revision: 1 })
        expect(await Storage.read(progressKey(session))).toMatchObject({
          reviewedThrough: { created: 2, messageID: user.id },
        })
        expect((await Session.get(session.id)).time).toEqual(before.time)
        const navAfter = (await SessionNav.readNavIndex(session.scope.id)).entries.find(
          (entry) => entry.id === session.id,
        )
        expect(navAfter?.lastActivityAt).toBe(navBefore?.lastActivityAt)
        const newer = await root(session.id, "Keep both project decisions.", 3)
        call.mockImplementation(async (input) => {
          const content = JSON.stringify(input.messages)
          expect(content).toContain(markdown.replaceAll("\n", "\\n"))
          expect(content).not.toContain("Project B is unrelated")
          expect(content).toContain("Keep both project decisions.")
          return { text: markdown, model }
        })
        events.length = 0
        const beforeReview = await Session.get(session.id)
        const navBeforeReview = (await SessionNav.readNavIndex(session.scope.id)).entries.find(
          (entry) => entry.id === session.id,
        )
        await update(newer)
        const reviewed = Session.publicInfo(await Session.get(session.id))
        expect(reviewed.longTermMemory).toEqual({ markdown, revision: 1 })
        expect(reviewed.time).toEqual(beforeReview.time)
        expect(reviewed).toHaveProperty("longTermMemoryReview", {
          reviewedThrough: { created: 3, messageID: newer.id },
        })
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          longTermMemory: { markdown, revision: 1 },
          longTermMemoryReview: { reviewedThrough: { created: 3, messageID: newer.id } },
          time: beforeReview.time,
        })
        expect((await Session.list()).data.map(Session.publicInfo)).toContainEqual(reviewed)
        expect(JSON.stringify(reviewed)).not.toContain('"digest"')
        expect(JSON.stringify(events)).not.toContain('"source"')
        expect(Session.publicInfo(Session.withoutRuntimeInfo(reviewed))).not.toHaveProperty("longTermMemoryReview")
        expect(independentExecutionInfo(reviewed)).not.toHaveProperty("longTermMemoryReview")
        expect(SessionRecords.serialize(reviewed)).not.toHaveProperty("longTermMemoryReview")
        expect(Session.PersistedInfo.parse(reviewed)).not.toHaveProperty("longTermMemoryReview")
        expect(await Storage.read(["sessions", session.scope.id, session.id, "info"])).not.toHaveProperty(
          "longTermMemoryReview",
        )
        expect(
          (await SessionNav.readNavIndex(session.scope.id)).entries.find((entry) => entry.id === session.id),
        ).toEqual(navBeforeReview)
        expect(await Storage.read(progressKey(session))).toMatchObject({
          reviewedThrough: { created: 3, messageID: newer.id },
        })
        await update(newer)
        expect(call).toHaveBeenCalledTimes(2)
        expect(events).toHaveLength(1)
        await Session.remove(session.id)
      },
    })
  }))

test("runtime review projection reads legacy progress without hydrating or validating original history", () =>
  withSession(async (session) => {
    using call = spyOn(AgentCall, "text")
    using originals = spyOn(SessionHistory, "originalMessages")
    using headers = spyOn(SessionHistory, "effectiveMessageInfos")
    expect(await Session.get(session.id)).not.toHaveProperty("longTermMemoryReview")
    await Storage.write(progressKey(session), {})
    expect(await Session.get(session.id)).not.toHaveProperty("longTermMemoryReview")
    expect((await Session.list()).data[0]).not.toHaveProperty("longTermMemoryReview")
    expect(await Storage.read(progressKey(session))).toEqual({})
    await Storage.remove(progressKey(session))
    await Session.update(session.id, (draft) => {
      draft.longTermMemory = { markdown: "# Legacy body without progress", revision: 1 }
    })
    expect(await Session.get(session.id)).not.toHaveProperty("longTermMemoryReview")
    const reviewedThrough = { created: 17, messageID: Identifier.ascending("message") }
    await Storage.write(progressKey(session), { reviewedThrough })
    const reviewed = await Session.get(session.id)
    expect(Session.publicInfo(reviewed)).toHaveProperty("longTermMemoryReview", { reviewedThrough })
    expect((await Session.list()).data.map(Session.publicInfo)).toContainEqual(reviewed)
    expect(await Storage.read(progressKey(session))).toEqual({ reviewedThrough })
    const forged = { reviewedThrough: { created: 999, messageID: Identifier.ascending("message") } }
    const updated = await Session.update(session.id, (draft) => {
      Object.assign(draft, { longTermMemoryReview: forged })
    })
    expect(updated).toHaveProperty("longTermMemoryReview", { reviewedThrough })
    expect(await Storage.read(["sessions", session.scope.id, session.id, "info"])).not.toHaveProperty(
      "longTermMemoryReview",
    )
    await Storage.remove(progressKey(session))
    expect(await Session.get(session.id)).not.toHaveProperty("longTermMemoryReview")
    expect(call).not.toHaveBeenCalled()
    expect(originals).not.toHaveBeenCalled()
    expect(headers).not.toHaveBeenCalled()
  }))

test("empty Markdown still publishes reviewed source progress without inventing a body revision", () =>
  withSession(async (session) => {
    const user = await root(session.id, "No durable summary content", 4)
    using call = spyOn(AgentCall, "text").mockResolvedValue({ text: "", model })
    const events: Session.Info[] = []
    using subscription = {
      [Symbol.dispose]: Bus.subscribe(SessionEvent.Updated, (event) => {
        if (event.properties.info.id === session.id) events.push(event.properties.info)
      }),
    }
    await update(user)
    const reviewed = await Session.get(session.id)
    expect(reviewed.longTermMemory).toBeUndefined()
    expect(reviewed).toHaveProperty("longTermMemoryReview", { reviewedThrough: SessionLongTermMemory.cursor(user) })
    expect(events).toHaveLength(1)
    expect(events[0]).toHaveProperty("longTermMemoryReview", { reviewedThrough: SessionLongTermMemory.cursor(user) })
    await SessionLongTermMemory.clear(session.id)
    expect(await Session.get(session.id)).not.toHaveProperty("longTermMemoryReview")
    expect(events).toHaveLength(2)
    expect(events[1]).not.toHaveProperty("longTermMemoryReview")
    expect(events[1]?.time).toEqual(reviewed.time)
  }))

test("session metadata preserves optional long-term Markdown without requiring legacy backfill", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        expect(Session.publicInfo(session)).not.toHaveProperty("longTermMemory")
        const memory = { markdown: "# Persistent context\n\nThe session covers multiple projects.\n", revision: 1 }
        const parsed = Session.Info.parse({ ...session, longTermMemory: memory })
        expect(parsed).toHaveProperty("longTermMemory", memory)
        await Session.remove(session.id)
      },
    })
  }))
