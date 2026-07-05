import { describe, expect, test } from "bun:test"
import path from "path"
import { BashTool } from "../../src/tool/bash"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { Truncate } from "../../src/tool/truncation"
import { ProcessRegistry } from "../../src/process/registry"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

function metadataTracker() {
  const calls: Array<{ metadata: any }> = []
  return {
    calls,
    ctx: {
      ...ctx,
      metadata: (val: any) => {
        calls.push(val)
      },
    },
  }
}

const projectRoot = path.join(__dirname, "../..")

function bunEval(script: string) {
  const executable = process.execPath.replace(/\\/g, "/")
  const encoded = Buffer.from(script).toString("base64")
  const evalScript = `eval(Buffer.from('${encoded}', 'base64').toString())`
  return `"${executable}" -e ${JSON.stringify(evalScript)}`
}

describe("tool.bash", () => {
  test("basic", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'test'",
            description: "Echo test message",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      },
    })
  })

  test("promotes printed local artifacts as attachments", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: bunEval(
              `Bun.write("contact-sheet.png", "fake image").then(() => {
  console.log(process.cwd().replace(/\\\\/g, "/") + "/contact-sheet.png")
})`,
            ),
            description: "Create contact sheet",
          },
          {
            ...ctx,
            messageID: "message_test",
          },
        )

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("contact-sheet.png")
        expect(result.attachments).toHaveLength(1)
        expect(result.attachments?.[0].filename).toBe("contact-sheet.png")
        expect(result.attachments?.[0].mime).toBe("image/png")
        expect(result.attachments?.[0].url.startsWith("asset://")).toBe(true)
      },
    })
  })

  test("runs locally with warning for placeholder link IDs", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            linkID: "undefined",
            command: "echo 'bad link'",
            description: "Echo bad link",
          },
          ctx,
        )
        expect(result.output).toContain("Synergy Link warning")
        expect(result.output).toContain("bad link")
        expect(result.metadata.warnings?.[0]?.code).toBe("synergy_link.invalid_link_id")
      },
    })
  })
})

describe("tool.bash permissions", () => {
  test("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].metadata.capability).toBe("shell")
        expect(requests[0].patterns).toContain("echo hello")
      },
    })
  })

  test("marks read-only shell commands as low-risk shell_read", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "ls -la 2>/dev/null; head -5 package.json",
            description: "Inspect files",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].metadata.capability).toBe("shell_read")
      },
    })
  })

  test("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo foo && echo bar",
            description: "Echo twice",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo foo")
        expect(requests[0].patterns).toContain("echo bar")
      },
    })
  })

  test("does not emit external_directory directly when cd to parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd ../",
            description: "Change to parent directory",
          },
          testCtx,
        )
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("does not emit external_directory directly when workdir is outside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "ls",
            workdir: "/tmp",
            description: "List /tmp",
          },
          testCtx,
        )
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
        expect(requests.find((r) => r.permission === "bash")).toBeDefined()
      },
    })
  })

  test("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }

        await Bun.write(path.join(tmp.path, "tmpfile"), "x")

        await bash.execute(
          {
            command: "rm tmpfile",
            description: "Remove tmpfile",
          },
          testCtx,
        )

        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })

  test("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "git log --oneline -5",
            description: "Git log",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].patterns.length).toBeGreaterThan(0)
      },
    })
  })

  test("does not ask for bash permission when command is cd only", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd .",
            description: "Stay in current directory",
          },
          testCtx,
        )
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeUndefined()
      },
    })
  })

  test("uses direct execution after profile approval instead of an existing sandbox wrapper", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const testCtx = {
          ...ctx,
          extra: {
            shellBypassSandbox: true,
            sandboxWrapper: {
              command: "false",
              args: [],
              sandboxed: true,
            },
          },
        }
        const result = await bash.execute(
          {
            command: "echo approved",
            description: "Approved shell",
          },
          testCtx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("approved")
      },
    })
  })
})

describe("tool.bash truncation", () => {
  test("truncates output exceeding line limit", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await bash.execute(
          {
            command: bunEval(`for (let i = 1; i <= ${lineCount}; i++) console.log(i)`),
            description: "Generate lines exceeding limit",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("truncates output exceeding byte limit", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await bash.execute(
          {
            command: bunEval(`process.stdout.write("a".repeat(${byteCount}))`),
            description: "Generate bytes exceeding limit",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  test("does not truncate small output", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: bunEval(`console.log("hello")`),
            description: "Echo hello",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(false)
        expect(result.output.replace(/\r\n/g, "\n")).toBe("hello\n")
      },
    })
  })

  test("full output is saved to file when truncated", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await bash.execute(
          {
            command: bunEval(`for (let i = 1; i <= ${lineCount}; i++) console.log(i)`),
            description: "Generate lines for file check",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(true)

        const filepath = (result.metadata as any).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Bun.file(filepath).text()
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})

describe("tool.bash output cap", () => {
  test("metadata output is capped at 30K via truncateMetadataOutput", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: bunEval(`process.stdout.write("x".repeat(300000))`),
            description: "Generate 300KB output",
          },
          ctx,
        )
        // truncateMetadataOutput caps at 30K; metadata.output should not exceed that
        expect((result.metadata.output ?? "").length).toBeLessThanOrEqual(30_000 + 100) // small margin for truncation marker
      },
    })
  })

  test("ProcessRegistry output is capped at 200K chars", async () => {
    ProcessRegistry.reset()
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: bunEval(`process.stdout.write("x".repeat(300000))`),
            background: true,
            description: "Generate 300KB output in background",
          },
          ctx,
        )
        expect(result.metadata.background).toBe(true)
        const processId = result.metadata.processId as string
        expect(processId).toBeTruthy()

        // Wait for process to finish
        const proc = ProcessRegistry.get(processId)
        if (proc) {
          // Wait up to 10s for exit
          for (let i = 0; i < 50; i++) {
            if (proc.exited) break
            await Bun.sleep(200)
          }
          expect(proc.output.length).toBeLessThanOrEqual(200_000)
          expect(proc.tail.length).toBeLessThanOrEqual(2_000)
        }

        // Clean up
        ProcessRegistry.remove(processId)
      },
    })
    ProcessRegistry.reset()
  })
})

describe("tool.bash metadata throttling", () => {
  test("high-frequency output produces fewer metadata updates than chunks", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const tracker = metadataTracker()

        await bash.execute(
          {
            command: `i=0; while [ $i -lt 100 ]; do echo "line $i"; i=$((i + 1)); done`,
            description: "Rapid output test",
          },
          tracker.ctx,
        )

        expect(tracker.calls.length).toBeGreaterThanOrEqual(2)
        expect(tracker.calls.length).toBeLessThan(30)
      },
    })
  }, 15_000)

  test("metadata is flushed on process exit even if timer has not fired", async () => {
    await ScopeContext.provide({
      scope: (await Scope.fromDirectory(projectRoot)).scope,
      fn: async () => {
        const bash = await BashTool.init()
        const tracker = metadataTracker()

        await bash.execute(
          {
            command: `echo "final output"`,
            description: "Exit flush test",
          },
          tracker.ctx,
        )

        // The last metadata call should contain the final output
        const lastCall = tracker.calls[tracker.calls.length - 1]
        expect(lastCall.metadata.output).toContain("final output")
      },
    })
  })
})

describe("tool.bash workspace boundary enforcement", () => {
  test("direct backend does not enforce worktree original-checkout boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalCheckout = "/tmp"

    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'direct backend'",
            workdir: originalCheckout,
            description: "Direct backend original checkout path",
          },
          ctx,
        )
        expect(result.output).toContain("direct backend")
      },
    })
  })

  test("workdir inside active workspace does not trigger boundary rejection", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
      },
      fn: async () => {
        const bash = await BashTool.init()
        // Bash with workdir inside the active workspace should succeed
        const result = await bash.execute(
          {
            command: "echo 'should work'",
            workdir: tmp.path,
            description: "Test in-workspace command",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("should work")
      },
    })
  })

  test("does not emit external_directory directly when command traverses toward original checkout", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalCheckout = path.resolve(tmp.path, "..", "original-checkout")

    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout,
      },
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd ../original-checkout && echo 'escaped'",
            description: "Navigate to original checkout",
          },
          testCtx,
        )
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("does not emit external_directory directly when workdir is outside active workspace", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
      },
      fn: async () => {
        const bash = await BashTool.init()
        const outsideDir = "/tmp/outside-" + Math.random().toString(36).slice(2)
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash
          .execute(
            {
              command: "ls",
              workdir: outsideDir,
              description: "List outside directory",
            },
            testCtx,
          )
          .catch(() => undefined)
        expect(requests.find((r) => r.permission === "external_directory")).toBeUndefined()
      },
    })
  })

  test("local bash backend leaves workspace validation to ToolResolver gate", async () => {
    await using tmp = await tmpdir({ git: true })

    await ScopeContext.provide({
      scope: await tmp.scope(),
      workspace: {
        type: "git_worktree",
        path: tmp.path,
        scopeID: (await tmp.scope()).id,
        originalCheckout: "/tmp/original-checkout-" + Math.random().toString(36).slice(2),
      },
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'test'",
            workdir: "/tmp",
            description: "Direct backend invocation",
          },
          ctx,
        )
        expect(result.output).toContain("test")
      },
    })
  })
})
