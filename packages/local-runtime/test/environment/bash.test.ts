import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { BashTool } from "../../src/tools/bash"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import path from "node:path"

test("Bash uses the selected Environment without requiring a Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: null,
      async fn() {
        const session = await Session.create({ workspace: null, controlProfile: "full_access" })
        const tool = await BashTool.init()
        const context = {
          sessionID: session.id,
          messageID: "message",
          callID: "call",
          agent: "synergy",
          abort: new AbortController().signal,
          environmentID: session.environmentID,
          extra: { shellAuthorizationResolved: true, shellBypassSandbox: true, controlProfile: "full_access" },
          metadata() {},
          async ask() {
            throw new Error("unexpected permission")
          },
        }
        const result = await tool.execute(
          { command: "printf environment", description: "Execute without files" },
          context,
        )
        expect(result.output).toBe("environment")
        expect(result.metadata.exit).toBe(0)
        const keys = await Storage.list(["environment_execution", session.scope.id])
        expect(keys).toHaveLength(1)
        expect((await Storage.read<{ state: string }>(keys[0]!)).state).toBe("completed")
        await expect(
          tool.execute(
            { command: "printf refused", description: "No execution authority" },
            { ...context, callID: "other", environmentID: null },
          ),
        ).rejects.toMatchObject({ name: "EnvironmentUnavailable" })
        expect(await Environment.uses(session.environmentID!)).toHaveLength(0)
      },
    })
  })
}, 20_000)

test.skipIf(process.platform === "win32")(
  "Bash preserves UTF-8 characters split independently across output streams",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        path.join(tmp.path, "output.js"),
        `
      process.stdout.write(Buffer.from([0xe4]));
      process.stderr.write(Buffer.from([0xe6]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0xb8, 0xad]));
        process.stderr.write(Buffer.from([0x96, 0x87]));
      }, 150);
    `,
      )
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const session = await Session.create({ controlProfile: "full_access" })
          const result = await (
            await BashTool.init()
          ).execute(
            { command: `"${process.execPath}" output.js`, description: "Read split text" },
            {
              sessionID: session.id,
              messageID: "message",
              callID: "utf8",
              agent: "synergy",
              abort: new AbortController().signal,
              environmentID: session.environmentID,
              extra: { shellAuthorizationResolved: true, shellBypassSandbox: true, controlProfile: "full_access" },
              metadata() {},
              async ask() {
                throw new Error("unexpected permission")
              },
            },
          )
          expect(result.output).toContain("中")
          expect(result.output).toContain("文")
          expect(result.output).not.toContain("�")
        },
      })
    })
  },
  20_000,
)
