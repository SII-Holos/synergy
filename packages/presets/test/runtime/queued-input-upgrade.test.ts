import { expect, test } from "bun:test"
import path from "node:path"
import { PresetRuntimeHandle } from "../../src/server/runtime-handle"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { RolloutLedger } from "@ericsanchezok/synergy-harness/session/rollout/ledger"
import { RolloutLifecycle } from "@ericsanchezok/synergy-harness/session/rollout/lifecycle"
import fixture from "../../../harness/test/storage/fixtures/v3.0.22.json"
import ledger from "../storage/fixtures/v3.0.22-migration-ledger.json"

test.each(["historical", "failed", "cancelled"] as const)(
  "queued input uses its own model after a %s root",
  async (previous) => {
    await using home = await runtimeHome()
    for (const record of fixture.records.slice(0, 4)) {
      await Bun.write(path.join(home.host.root, "data", ...record.key) + ".json", JSON.stringify(record.value))
    }
    await Bun.write(
      path.join(home.host.root, "data/meta/migration/log.json"),
      JSON.stringify(Object.fromEntries(ledger.completed.map((id) => [id, 1]))),
    )
    let calls = 0
    using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls++
        const body = (await request.json()) as { stream?: boolean }
        const message = { role: "assistant", content: "New input completed" }
        const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        if (!body.stream)
          return Response.json({
            id: "fixture",
            object: "chat.completion",
            created: 0,
            model: "model",
            choices: [{ index: 0, message, finish_reason: "stop" }],
            usage,
          })
        return new Response(
          [
            { choices: [{ index: 0, delta: message, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
          ]
            .map(
              (frame) =>
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "model", ...frame })}\n\n`,
            )
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    await using runtime = await PresetRuntimeHandle.openTask({
      host: {
        ...home.host,
        env: {
          ...home.host.env,
          SYNERGY_CONFIG_CONTENT: JSON.stringify({
            model: "fixture/model",
            enabled_providers: ["fixture"],
            library: { memory: { enabled: false }, experience: { retrieve: false, encode: false }, autonomy: false },
            provider: {
              fixture: {
                name: "Fixture",
                npm: "@ai-sdk/openai-compatible",
                env: [],
                models: { model: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
                options: { apiKey: "fixture", baseURL: provider.url.toString() },
              },
            },
          }),
        },
      },
      mode: "oneshot",
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const session = await Session.get("ses_00000000000000000000000001")
          if (previous !== "historical") {
            await RolloutLedger.beginRun(RolloutLifecycle.owner(session), "msg_00000000000000000000000001")
            await RolloutLedger.finishRun(RolloutLifecycle.owner(session), "msg_00000000000000000000000001", previous)
          }
          const item = await SessionInbox.enqueueUser({
            sessionID: session.id,
            model: { providerID: "fixture", modelID: "model" },
            parts: [{ type: "text", text: "Run this new input" }],
          })
          await SessionManager.wake(session.id)
          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.filter((message) => message.info.id === item.messageID)).toHaveLength(1)
          expect(
            messages.some(
              (message) =>
                message.info.role === "assistant" &&
                message.info.parentID === item.messageID &&
                message.parts.some((part) => part.type === "text" && part.text === "New input completed"),
            ),
          ).toBe(true)
          expect(await SessionInbox.list(session.id)).toHaveLength(0)
          expect(calls).toBeGreaterThan(0)
        },
      }),
    )
  },
  30_000,
)
