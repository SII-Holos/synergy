import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { ChannelCommand } from "@ericsanchezok/synergy-channels/channel/command"
import { blueprint } from "@ericsanchezok/synergy-blueprint/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { registerWorker } from "../src/worker"

for (const selected of [false, true])
  test(`channel-blueprint explicitly controls command execution and help (${selected})`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          registerLocalRuntime()
          channels().register()
          note().register()
          blueprint().register()
          if (selected) registerWorker()
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const context = { channelType: "test", accountId: "fixture", chatId: "chat", messageId: "message" }
          const endpoint = SessionEndpoint.fromChannel({ type: "test", accountId: "fixture", chatId: "chat" })
          const help = await ChannelCommand.execute("/help", context, Scope.home())
          expect(help.action === "handled" && help.reply?.includes("/blueprint")).toBe(selected)
          expect(await ChannelCommand.execute("/blueprint request", context, Scope.home())).toEqual(
            selected ? { action: "continue", text: "request" } : { action: "skip" },
          )
          expect((await Session.findForEndpoint(endpoint, { scope: Scope.home() }))?.workflow?.kind).toBe(
            selected ? "plan" : undefined,
          )

          if (selected)
            expect(await ChannelCommand.execute("/plan more", context, Scope.home())).toEqual({
              action: "continue",
              text: "more",
            })

          if (selected) {
            expect(await ChannelCommand.execute("/chat", context, Scope.home())).toEqual({
              action: "handled",
              reply: "✅ Switched to normal chat.",
            })
            expect((await Session.findForEndpoint(endpoint, { scope: Scope.home() }))?.workflow).toBeUndefined()
          }
        },
      }),
    )
  }, 20_000)
