import { afterAll, expect, test } from "bun:test"
import { Tool } from "../../src/tool/tool"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMigrationTarget } from "../../src/migration/session-target"
import { MigrationRegistry } from "../../src/migration/registry"
import { RolloutArtifact } from "../../src/session/rollout/artifact"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

const runtime = await testRuntime({
  register() {
    Tool.registerInputHistory("test-shell", { bash: { description: "workBrief" } })
    Tool.registerInputHistory("test-agenda", {
      agenda_schedule: {
        title: "agendaTitle",
        prompt: "executionInstructions",
        timeout: { name: "timeoutSeconds", scale: 0.001 },
      },
    })
  },
})
afterAll(() => runtime.close())

test("owned message migrations preserve intent and audit bytes, and are idempotent", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          agent: "test",
          model: { providerID: "test", modelID: "test" },
          time: { created: 1 },
        })
        const owner = { scopeID: session.scope.id, sessionID: session.id }
        const auditOwner = { kind: "session" as const, ...owner }
        const raw = '{"command":"pwd","description":"Inspect project"}'
        const audit = await RolloutArtifact.writeText(auditOwner, raw)
        const parts: MessageV2.ToolPart[] = [
          {
            id: Identifier.ascending("part"),
            messageID,
            sessionID: session.id,
            type: "tool",
            tool: "bash",
            callID: "shell",
            state: {
              status: "completed",
              input: { command: "pwd", description: " Inspect project " },
              title: "pwd",
              output: "test",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
          {
            id: Identifier.ascending("part"),
            messageID,
            sessionID: session.id,
            type: "tool",
            tool: "agenda_schedule",
            callID: "schedule",
            state: {
              status: "error",
              input: { title: "old", agendaTitle: "kept", prompt: "Report results", timeout: 30000 },
              error: "failure",
              time: { start: 2, end: 3 },
            },
          },
        ]
        for (const part of parts) await Session.updatePart(part)
        const before = await SessionHistoryDisplay.partPage({ sessionID: session.id, messageID }, owner.scopeID)
        const migrations = MigrationRegistry.list()
        const shell = migrations.get("tool-input-test-shell")![0]
        const agenda = migrations.get("tool-input-test-agenda")![0]
        await shell.upSession!(owner, () => {})
        let saved = await MessageV2.parts({ sessionID: session.id, messageID })
        expect(saved[0]).toMatchObject({ workBrief: "Inspect project", state: { input: { command: "pwd" } } })
        expect((saved[1] as MessageV2.ToolPart).state.input).toHaveProperty("title", "old")
        await agenda.upSession!(owner, () => {})
        saved = await MessageV2.parts({ sessionID: session.id, messageID })
        expect((saved[1] as MessageV2.ToolPart).state.input).toEqual({
          agendaTitle: "kept",
          executionInstructions: "Report results",
          timeoutSeconds: 30,
        })
        await SessionMigrationTarget.provide(owner, () => shell.up(() => {}))
        expect(await MessageV2.parts({ sessionID: session.id, messageID })).toEqual(saved)
        const after = await SessionHistoryDisplay.partPage({ sessionID: session.id, messageID }, owner.scopeID)
        expect(after.items[0].content.version).not.toBe(before.items[0].content.version)
        expect(after.items[0].content).toEqual(SessionHistoryDisplay.summarizePart(saved[0]).content)
        const chunks: Uint8Array[] = []
        for await (const chunk of RolloutArtifact.read(auditOwner, audit)) chunks.push(chunk)
        expect(Buffer.concat(chunks).toString()).toBe(raw)
        expect(saved.some((part) => part.type === "tool" && part.activityEvidence)).toBe(false)
      },
    })
  }))
