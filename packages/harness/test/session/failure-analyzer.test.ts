import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { LoopJob } from "../../src/session/loop-job"
import { registerFailureAnalyzer, SearchFailureAnalyzer, SearchGuard } from "../../src/tool/search-guard"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"

for (const status of ["completed", "error"] as const) {
  test(`registered failure analyzers receive their declared tools: ${status}`, async () => {
    await using runtime = await testRuntime({
      register() {
        registerFailureAnalyzer({
          ...SearchFailureAnalyzer,
          category: "custom-search",
          tools: new Set(["custom_search"]),
          agentFilter: ["synergy"],
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.create({ workspace: null })
          const user: MessageV2.User = {
            id: Identifier.ascending("message"),
            sessionID: session.id,
            role: "user",
            isRoot: true,
            agent: "synergy",
            model: { providerID: "fixture", modelID: "fixture" },
            time: { created: Date.now() },
          }
          await Session.updateMessage(user)
          async function recordQueries(queries: string[]) {
            for (const query of queries) {
              const assistant: MessageV2.Assistant = {
                id: Identifier.ascending("message"),
                sessionID: session.id,
                rootID: user.id,
                parentID: user.id,
                role: "assistant",
                agent: "synergy",
                mode: "synergy",
                path: { cwd: null, root: null },
                providerID: "fixture",
                modelID: "fixture",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: Date.now(), completed: Date.now() },
              }
              await Session.updateMessage(assistant)
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "tool",
                tool: "custom_search",
                callID: crypto.randomUUID(),
                state:
                  status === "completed"
                    ? {
                        status,
                        input: { query },
                        output: "No search results found",
                        title: "Search",
                        metadata: { searchFailureType: "no_results" },
                        time: { start: 1, end: 2 },
                      }
                    : {
                        status,
                        input: { query },
                        error: "Search request timed out",
                        time: { start: 1, end: 2 },
                      },
              })
            }
          }
          await recordQueries(["first", "second"])
          const context: LoopJob.Context = {
            session,
            sessionID: session.id,
            step: 2,
            messages: [{ info: user, parts: [] }],
            lastUser: user,
            lastUserParts: [],
            abort: new AbortController().signal,
          }
          expect(await LoopJob.detectSignals(context)).toContain("tool_failure_pattern")
          await LoopJob.execute([{ type: "tool_failure_pattern_injector" }], context)
          expect(
            context.lastUserParts.some(
              (part) => part.type === "text" && part.text.includes(SearchGuard.REFLECTION_MARKER),
            ),
          ).toBeTrue()
          expect(await LoopJob.detectSignals(context)).not.toContain("tool_failure_pattern")
          await recordQueries(["third", "fourth"])
          expect(await LoopJob.detectSignals(context)).toContain("tool_failure_pattern")
          await LoopJob.execute([{ type: "tool_failure_pattern_injector" }], context)
          expect(
            context.lastUserParts.some(
              (part) => part.type === "text" && part.text.includes(SearchGuard.EARLY_STOP_MARKER),
            ),
          ).toBeTrue()
          const newer = await Session.updateMessage({
            ...user,
            id: Identifier.ascending("message"),
            time: { created: Date.now() },
          })
          const newContext = {
            ...context,
            lastUser: MessageV2.User.parse(newer),
            lastUserParts: [],
            messages: [{ info: newer, parts: [] }],
          }
          expect(await LoopJob.detectSignals(newContext)).not.toContain("tool_failure_pattern")
        },
      }),
    )
  })
}
