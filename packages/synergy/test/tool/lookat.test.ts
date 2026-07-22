import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import path from "path"
import { LookAtTool } from "../../src/tool/lookat"
import { Agent } from "../../src/agent/agent"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionInvoke } from "../../src/session/invoke"

const ctx = {
  sessionID: "ses_test123",
  messageID: "msg_test123",
  callID: "call_test123",
  agent: "developer",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

type InvokePart = {
  type: string
  filename?: string
  mime?: string
  model?: {
    mode: string
  }
}

// Custom error to signal that the test reached the AI call point
class MockAICallError extends Error {
  constructor() {
    super("Mock: AI call would happen here")
  }
}

describe("tool.look_at", () => {
  // Mock Session.create to avoid real AI calls
  let originalSessionCreate: typeof Session.create
  let sessionCreateCalls: Array<Parameters<typeof Session.create>[0]>

  beforeEach(() => {
    originalSessionCreate = Session.create
    sessionCreateCalls = []
    ;(Session.create as any) = mock(async (input?: Parameters<typeof Session.create>[0]) => {
      sessionCreateCalls.push(input)
      throw new MockAICallError()
    })
  })

  afterEach(() => {
    // Restore original Session.create after each test
    ;(Session.create as any) = originalSessionCreate
  })

  describe("file validation", () => {
    test("returns error when file does not exist", async () => {
      // Restore original for this test since it should return before AI call
      ;(Session.create as any) = originalSessionCreate
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const result = await lookat.execute({ file_path: "/nonexistent/file.png", goal: "describe the image" }, ctx)
          expect(result.output).toContain("Error: File not found")
          expect(result.metadata.error).toBe("file_not_found")
        },
      })
    })

    test("verifies file exists before proceeding", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "test.png"), png)
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const result = await lookat.execute({ file_path: path.join(tmp.path, "test.png"), goal: "describe" }, ctx)
          expect(result.output).not.toContain("File not found")
          expect(result.metadata.error).not.toBe("file_not_found")
        },
      })
    })

    test("creates a single unattended child session for analysis", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "test.png"), png)
        },
      })
      const originalGetAvailableModel = Agent.getAvailableModel
      ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test", modelID: "model" }))
      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const lookat = await LookAtTool.init()
            await lookat.execute({ file_path: path.join(tmp.path, "test.png"), goal: "describe" }, ctx).catch(() => {})
            expect(sessionCreateCalls[0]?.interaction).toEqual(SessionInteraction.unattended("tool:look_at"))
          },
        })
      } finally {
        ;(Agent.getAvailableModel as any) = originalGetAvailableModel
      }
    })

    test("rejects more than 5 images", async () => {
      ;(Session.create as any) = originalSessionCreate
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          for (let i = 1; i <= 6; i++) {
            await Bun.write(path.join(dir, `img${i}.png`), png)
          }
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const paths = Array.from({ length: 6 }, (_, i) => path.join(tmp.path, `img${i + 1}.png`))
          const result = await lookat.execute({ file_path: paths, goal: "describe" }, ctx)
          expect(result.metadata.error).toBe("too_many_files")
          expect(result.metadata.fileCount).toBe(6)
          expect(result.output).toContain("At most 5 images")
        },
      })
    })

    test("allows exactly 5 images", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          for (let i = 1; i <= 5; i++) {
            await Bun.write(path.join(dir, `img${i}.png`), png)
          }
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const paths = Array.from({ length: 5 }, (_, i) => path.join(tmp.path, `img${i + 1}.png`))
          const result = await lookat.execute({ file_path: paths, goal: "describe" }, ctx).catch(() => {})
          // Should not have too_many_files error — it passes validation and reaches Session.create
          expect(result?.metadata?.error).not.toBe("too_many_files")
        },
      })
    })

    test("multiple images create exactly one child session with multiple file parts", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "a.png"), png)
          await Bun.write(path.join(dir, "b.png"), png)
          await Bun.write(path.join(dir, "c.png"), png)
        },
      })

      const originalAgentGet = Agent.get
      const originalGetAvailableModel = Agent.getAvailableModel
      const originalCancel = SessionInvoke.cancel
      const originalInvokeInternal = SessionInvoke.invokeInternal
      let invokeInput: { parts?: InvokePart[]; origin?: { type: string } } | undefined
      ;(Agent.get as any) = mock(async () => ({ name: "multimodal-looker" }))
      ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test", modelID: "model" }))
      ;(Session.create as any) = mock(async (input?: Parameters<typeof Session.create>[0]) => {
        sessionCreateCalls.push(input)
        return { id: "ses_batch" }
      })
      ;(SessionInvoke.invokeInternal as any) = mock(
        async (input: { parts?: InvokePart[]; origin?: { type: string } }) => {
          invokeInput = input
          return { parts: [{ type: "text", text: "## a.png\n...\n\n## b.png\n...\n\n## c.png\n..." }] }
        },
      )
      ;(SessionInvoke.cancel as any) = mock(() => {})

      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const lookat = await LookAtTool.init()
            const result = await lookat.execute(
              {
                file_path: [path.join(tmp.path, "a.png"), path.join(tmp.path, "b.png"), path.join(tmp.path, "c.png")],
                goal: "describe each",
              },
              ctx,
            )

            // Exactly one session was created
            expect(sessionCreateCalls).toHaveLength(1)

            // It contains one text part + three provider-file attachment parts
            const textParts = invokeInput?.parts?.filter((p) => p.type === "text") ?? []
            const attachmentParts = invokeInput?.parts?.filter((p) => p.type === "attachment") ?? []
            expect(textParts).toHaveLength(1)
            expect(attachmentParts).toHaveLength(3)
            expect(attachmentParts.map((p) => p.filename)).toEqual(["a.png", "b.png", "c.png"])
            expect(attachmentParts.map((p) => p.mime)).toEqual(["image/png", "image/png", "image/png"])
            expect(attachmentParts.map((p) => p.model?.mode)).toEqual([
              "provider-file",
              "provider-file",
              "provider-file",
            ])
            expect(invokeInput?.origin).toEqual({ type: "system" })

            expect(result.title).toBe("Analyzed 3 files")
            expect(result.output).toContain("## a.png")
          },
        })
      } finally {
        ;(Agent.get as any) = originalAgentGet
        ;(Agent.getAvailableModel as any) = originalGetAvailableModel
        ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
        ;(SessionInvoke.cancel as any) = originalCancel
      }
    })
  })

  describe("user-visible attachments", () => {
    test("attaches analyzed images when show_to_user is true", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "visible.png"), png)
        },
      })

      const originalAgentGet = Agent.get
      const originalGetAvailableModel = Agent.getAvailableModel
      const originalInvokeInternal = SessionInvoke.invokeInternal
      const originalCancel = SessionInvoke.cancel

      ;(Agent.get as any) = mock(async () => ({ name: "multimodal-looker" }))
      ;(Agent.getAvailableModel as any) = mock(async () => ({ providerID: "test", modelID: "model" }))
      ;(Session.create as any) = mock(async (input?: Parameters<typeof Session.create>[0]) => {
        sessionCreateCalls.push(input)
        return { id: "ses_child" }
      })
      ;(SessionInvoke.invokeInternal as any) = mock(async () => ({ parts: [{ type: "text", text: "one pixel" }] }))
      ;(SessionInvoke.cancel as any) = mock(() => {})

      try {
        await ScopeContext.provide({
          scope: await tmp.scope(),
          fn: async () => {
            const lookat = await LookAtTool.init()
            const result = await lookat.execute(
              { file_path: path.join(tmp.path, "visible.png"), goal: "describe", show_to_user: true },
              ctx,
            )

            expect(result.output).toBe("one pixel")
            expect(result.metadata.shownToUser).toBe(true)
            expect(result.attachments).toHaveLength(1)
            expect(result.attachments?.[0]?.mime).toBe("image/png")
            expect(result.attachments?.[0]?.filename).toBe("visible.png")
            expect(result.attachments?.[0]?.url).toStartWith("asset://")
          },
        })
      } finally {
        ;(Agent.get as any) = originalAgentGet
        ;(Agent.getAvailableModel as any) = originalGetAvailableModel
        ;(SessionInvoke.invokeInternal as any) = originalInvokeInternal
        ;(SessionInvoke.cancel as any) = originalCancel
      }
    })
  })

  describe("external_directory permission", () => {
    test("does not emit external_directory directly when file is outside project directory", async () => {
      await using outerTmp = await tmpdir({
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "external.png"), png)
        },
      })
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const requests: Array<{ permission: string; patterns: string[] }> = []
          const testCtx = {
            ...ctx,
            ask: async (req: { permission: string; patterns: string[] }) => {
              requests.push(req)
              // Continue to let it reach the mocked AI call
            },
          }
          await lookat
            .execute({ file_path: path.join(outerTmp.path, "external.png"), goal: "describe" }, testCtx)
            .catch(() => {})

          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        },
      })
    })

    test("does not ask for permission when file is inside project directory", async () => {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const png = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
            "base64",
          )
          await Bun.write(path.join(dir, "internal.png"), png)
        },
      })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const requests: Array<{ permission: string }> = []
          const testCtx = {
            ...ctx,
            ask: async (req: { permission: string }) => {
              requests.push(req)
            },
          }
          await lookat
            .execute({ file_path: path.join(tmp.path, "internal.png"), goal: "describe" }, testCtx)
            .catch(() => {})

          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        },
      })
    })
  })
})
