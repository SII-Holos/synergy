import { expect, test } from "bun:test"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionReadSource } from "@ericsanchezok/synergy-harness/session/read-source"
import { SessionReadTool } from "../../src/tools/session-read"
import { testRuntime } from "../support/runtime"

test("session_read keeps personal history and never falls back after a composed source handles or refuses it", async () => {
  const refusal = new Error("The owning service denied the private history")
  let mode: "refuse" | "projection" = "refuse"
  await using guarded = await testRuntime({
    register() {
      SessionReadSource.register({
        async resolve() {
          if (mode === "refuse") throw refusal
          return {
            kind: "projection",
            result: {
              title: "Shared window",
              output: "Authorized projection only",
              metadata: { projectionOnly: true },
            },
          }
        },
      })
    },
  })
  await using personal = await testRuntime()
  const prepare = (runtime: typeof personal, text: string) =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const messageID = Identifier.ascending("message")
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: PrimaryAgentIdentity.names.general,
            model: { providerID: "fixture", modelID: "fixture" },
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "text",
            origin: "user",
            text,
          })
          return session.id
        },
      }),
    )
  const personalID = await prepare(personal, "Personal native history is retained")
  const guardedID = await prepare(guarded, "Private native history must not be substituted")
  const read = (runtime: typeof personal, sessionID: string) =>
    runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const tool = await SessionReadTool.init()
          return tool.execute(
            { target: sessionID, limit: 20, offset: 0 },
            {
              sessionID,
              messageID: "msg_reader",
              callID: "call_reader",
              agent: PrimaryAgentIdentity.names.general,
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            },
          )
        },
      }),
    )
  expect((await read(personal, personalID)).output).toContain("Personal native history is retained")
  await expect(read(guarded, guardedID)).rejects.toBe(refusal)
  mode = "projection"
  const projected = await read(guarded, "ses_not_in_the_native_store")
  expect(projected.output).toBe("Authorized projection only")
  expect(projected.metadata).toMatchObject({ projectionOnly: true })
  expect((await read(personal, personalID)).output).toContain("Personal native history is retained")
})
