import { expect, test } from "bun:test"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ComputerAppsTool } from "../src/tools"

test("native dispatch rechecks a profile downgraded after tool initialization", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const session = await Session.create({ controlProfile: "full_access" })
      try {
        const tool = await ComputerAppsTool.init()
        for (const profile of ["guarded", "autonomous"] as const) {
          await Session.updateControlProfile(session.id, profile)
          await expect(
            tool.execute(
              {},
              {
                sessionID: session.id,
                messageID: "msg_not_dispatched",
                agent: "synergy",
                abort: new AbortController().signal,
                metadata() {},
                async ask() {
                  throw new Error("Must not ask for an approval")
                },
              },
            ),
          ).rejects.toThrow("Computer Use requires Full Access")
        }
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

test("successful observation stores screenshots as durable attachments for a text-only model", async () => {
  const { spyOn } = await import("bun:test")
  const { computerBroker } = await import("../src/broker")
  const { ComputerObserveTool } = await import("../src/tools")
  const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")
  const execute = spyOn(computerBroker, "execute").mockResolvedValue({
    output: "Window observed",
    observationId: "observation-1",
    images: [{ mimeType: "image/png", data: Buffer.from("image-content").toString("base64") }],
    metadata: {},
  })
  await using tmp = await tmpdir({ git: true })
  try {
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ controlProfile: "full_access" })
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
        })
        const tool = await ComputerObserveTool.init()
        const result = await tool.execute(
          { pid: 12, windowId: 34 },
          {
            sessionID: session.id,
            messageID,
            agent: "synergy",
            abort: new AbortController().signal,
            metadata() {},
            async ask() {
              throw new Error("Unexpected approval")
            },
          },
        )
        expect(result.output).toBe("Window observed")
        expect(result.metadata).toMatchObject({ observationId: "observation-1", deliveryMode: "background" })
        expect(result.attachments).toHaveLength(1)
        expect(result.attachments![0]!.url).toStartWith("asset://")
        expect(result.attachments![0]!.model?.mode).toBe("summary")
        expect(await Bun.file(result.attachments![0]!.localPath!).text()).toBe("image-content")
        expect(execute.mock.calls[0]?.[1]).toEqual({ type: "observe", pid: 12, windowId: 34 })
        await Session.remove(session.id)
      },
    })
  } finally {
    execute.mockRestore()
  }
})
