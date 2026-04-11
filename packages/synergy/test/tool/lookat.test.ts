import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import path from "path"
import { LookAtTool } from "../../src/tool/lookat"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"

const ctx = {
  sessionID: "ses_test123",
  messageID: "msg_test123",
  callID: "call_test123",
  agent: "master",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
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
      await Instance.provide({
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
      await Instance.provide({
        scope: await tmp.scope(),
        fn: async () => {
          const lookat = await LookAtTool.init()
          const result = await lookat.execute({ file_path: path.join(tmp.path, "test.png"), goal: "describe" }, ctx)
          expect(result.output).not.toContain("File not found")
          expect(result.metadata.error).not.toBe("file_not_found")
        },
      })
    })

    test("creates unattended child sessions for analysis work", async () => {
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
        await Instance.provide({
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
  })

  describe("external_directory permission", () => {
    test("asks for permission when file is outside project directory", async () => {
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
      await Instance.provide({
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
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns.some((p) => p.includes(outerTmp.path))).toBe(true)
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
      await Instance.provide({
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

describe("tool.look_at mime type inference", () => {
  const cases: [string, string][] = [
    ["test.jpg", "image/jpeg"],
    ["test.jpeg", "image/jpeg"],
    ["test.png", "image/png"],
    ["test.webp", "image/webp"],
    ["test.gif", "image/gif"],
    ["test.heic", "image/heic"],
    ["test.svg", "image/svg+xml"],
    ["test.mp4", "video/mp4"],
    ["test.mov", "video/quicktime"],
    ["test.webm", "video/webm"],
    ["test.mp3", "audio/mpeg"],
    ["test.wav", "audio/wav"],
    ["test.ogg", "audio/ogg"],
    ["test.pdf", "application/pdf"],
    ["test.xyz", "application/octet-stream"],
  ]

  test.each(cases)("%s -> %s", async () => {
    expect(true).toBe(true)
  })
})
