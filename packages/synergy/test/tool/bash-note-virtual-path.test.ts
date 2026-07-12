import { describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { NoteMarkdown, NoteStore } from "../../src/note"
import { ProcessRegistry } from "../../src/process/registry"
import { ScopeContext } from "../../src/scope/context"
import { BashTool } from "../../src/tool/bash"
import { BashVirtualFile } from "../../src/tool/bash/virtual-file"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"
import { Shell } from "../../src/util/shell"
import { tmpdir } from "../fixture/fixture"

const baseContext = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "test-strategist",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
  extra: { shellBypassSandbox: true },
} as any

async function withNote<T>(markdown: string, fn: (noteID: string, root: string) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const note = await NoteStore.create({
        title: "Bash virtual file",
        content: NoteMarkdown.fromMarkdown(markdown),
      })
      return fn(note.id, tmp.path)
    },
  })
}

async function waitForFinished(processID: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const finished = ProcessRegistry.getFinished(processID)
    if (finished) return finished
    await Bun.sleep(10)
  }
  throw new Error(`Process did not finish: ${processID}`)
}

describe("bash note virtual paths", () => {
  test("passes note markdown as file bytes without evaluating shell syntax", async () => {
    await withNote(
      "safe\n$(touch should-not-run)\n`touch should-not-run-either`\n; touch still-not-code",
      async (noteID, root) => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: `cat /synergy/note/${noteID}`,
            description: "Read reviewed note",
          },
          baseContext,
        )

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("$(touch should-not-run)")
        expect(await Bun.file(`${root}/should-not-run`).exists()).toBe(false)
        expect(await Bun.file(`${root}/should-not-run-either`).exists()).toBe(false)
        expect(await Bun.file(`${root}/still-not-code`).exists()).toBe(false)
      },
    )
  })

  test("supports quoted paths and multiple reviewed notes", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const left = await NoteStore.create({ title: "Left", content: NoteMarkdown.fromMarkdown("left") })
        const right = await NoteStore.create({ title: "Right", content: NoteMarkdown.fromMarkdown("right") })
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command:
              `cat '/synergy/note/${left.id}' && cat \"/synergy/note/${right.id}\" && ` +
              `diff /synergy/note/${left.id} /synergy/note/${left.id}`,
            description: "Consume reviewed notes",
          },
          baseContext,
        )

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toContain("left")
        expect(result.output).toContain("right")
      },
    })
  })

  test("preserves non-ASCII command text before a virtual path", async () => {
    await withNote("reviewed", async (noteID) => {
      const bash = await BashTool.init()
      const result = await bash.execute(
        {
          command: `printf '你好\\n' && cat /synergy/note/${noteID}`,
          description: "Consume a reviewed note after Unicode text",
        },
        baseContext,
      )

      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("你好")
      expect(result.output).toContain("reviewed")
    })
  })

  test("does not resolve virtual-looking text in shell comments", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "printf ok # /synergy/note/nte_missing",
            description: "Print literal text",
          },
          baseContext,
        )

        expect(result.metadata.exit).toBe(0)
        expect(result.output).toBe("ok")
      },
    })
  })

  test("fails before spawning when a referenced note does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bash = await BashTool.init()
        const marker = `${tmp.path}/spawned`
        const tempRoot = path.join(tmp.path, "staging")
        await mkdir(tempRoot)
        await expect(
          bash.execute(
            {
              command: `touch ${JSON.stringify(marker)} && cat /synergy/note/nte_missing`,
              description: "Consume missing note",
            },
            baseContext,
          ),
        ).rejects.toThrow("Note not found: nte_missing")
        expect(await Bun.file(marker).exists()).toBe(false)

        const command = "/synergy/note/nte_missing"
        await expect(
          BashVirtualFile.materialize({
            command,
            references: [{ startIndex: 0, endIndex: command.length, provider: "note", id: "nte_missing" }],
            scopeID: ScopeContext.current.scope.id,
            tempRoot,
          }),
        ).rejects.toThrow("Note not found: nte_missing")
        expect(await readdir(tempRoot)).toEqual([])
      },
    })
  })

  test("removes private materialized files after foreground execution", async () => {
    await withNote("reviewed", async (noteID) => {
      const bash = await BashTool.init()
      const result = await bash.execute(
        {
          command: `printf %s /synergy/note/${noteID}`,
          description: "Inspect staged note path",
        },
        baseContext,
      )
      const materializedPath = result.output.trim()

      expect(materializedPath).not.toContain("/synergy/note/")
      expect(await Bun.file(materializedPath).exists()).toBe(false)
    })
  })

  test("quotes materialized paths without changing shell argument boundaries", async () => {
    await withNote("reviewed", async (noteID, root) => {
      const tempRoot = path.join(root, "temp with ' quote")
      await mkdir(tempRoot)
      const virtualPath = `/synergy/note/${noteID}`
      const command = `cat ${virtualPath}`
      const materialized = await BashVirtualFile.materialize({
        command,
        references: [
          {
            startIndex: command.indexOf(virtualPath),
            endIndex: command.length,
            provider: "note",
            id: noteID,
          },
        ],
        scopeID: ScopeContext.current.scope.id,
        tempRoot,
      })
      try {
        const result = Bun.spawnSync([Shell.acceptable(), "-c", materialized.command], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toContain("reviewed")
      } finally {
        materialized.cleanup()
      }
    })
  })

  test("isolates concurrent materializations of the same note", async () => {
    await withNote("reviewed", async (noteID) => {
      const bash = await BashTool.init()
      const execute = () =>
        bash.execute(
          {
            command: `printf %s /synergy/note/${noteID}`,
            description: "Inspect concurrent note path",
          },
          baseContext,
        )
      const [left, right] = await Promise.all([execute(), execute()])
      const leftPath = left.output.trim()
      const rightPath = right.output.trim()

      expect(leftPath).not.toBe(rightPath)
      expect(await Bun.file(leftPath).exists()).toBe(false)
      expect(await Bun.file(rightPath).exists()).toBe(false)
    })
  })

  test("keeps files for background consumers and removes them on process exit", async () => {
    await withNote("reviewed", async (noteID) => {
      const bash = await BashTool.init()
      const result = await bash.execute(
        {
          command: `printf '%s\\n' /synergy/note/${noteID}; sleep 0.2`,
          description: "Keep reviewed note available",
          yieldSeconds: 0.02,
        },
        baseContext,
      )
      const processID = result.metadata.processId
      expect(processID).toBeString()

      const running = ProcessRegistry.get(processID!)
      const materializedPath = running?.output.trim()
      expect(materializedPath).toBeString()
      expect(await Bun.file(materializedPath!).exists()).toBe(true)
      if (process.platform !== "win32") {
        expect((await stat(materializedPath!)).mode & 0o777).toBe(0o400)
        expect((await stat(path.dirname(materializedPath!))).mode & 0o777).toBe(0o700)
      }

      const finished = await waitForFinished(processID!)
      expect(finished.command).toContain(`/synergy/note/${noteID}`)
      expect(await Bun.file(materializedPath!).exists()).toBe(false)
      ProcessRegistry.remove(processID!)
    })
  })

  test("reads the latest user-edited note after command approval", async () => {
    await withNote("draft", async (noteID) => {
      const bash = await BashTool.init()
      const result = await bash.execute(
        {
          command: `cat /synergy/note/${noteID}`,
          description: "Read approved note revision",
        },
        {
          ...baseContext,
          ask: async () => {
            const current = await NoteStore.getAny(ScopeContext.current.scope.id, noteID)
            await NoteStore.update(ScopeContext.current.scope.id, noteID, {
              expectedVersion: current.version,
              content: NoteMarkdown.fromMarkdown("user-reviewed"),
            })
          },
          extra: {
            sandboxPrepare: async (input: { command: string }) => ({
              command: Shell.acceptable(),
              args: ["-c", input.command],
              sandboxed: false,
            }),
          },
        },
      )

      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("user-reviewed")
      expect(result.output).not.toContain("draft")
    })
  })

  test("prepares the sandbox from the materialized command and read-only staging root", async () => {
    await withNote("sandboxed", async (noteID) => {
      const bash = await BashTool.init()
      let prepared: { command: string; extraReadRoots: string[] } | undefined
      const result = await bash.execute(
        {
          command: `cat /synergy/note/${noteID}`,
          description: "Read sandboxed note",
        },
        {
          ...baseContext,
          extra: {
            sandboxPrepare: async (input: { command: string; extraReadRoots: string[] }) => {
              prepared = input
              return {
                command: Shell.acceptable(),
                args: ["-c", input.command],
                sandboxed: false,
              }
            },
            sandboxFallback: "deny",
          },
        },
      )

      expect(result.metadata.exit).toBe(0)
      expect(result.output).toContain("sandboxed")
      expect(prepared?.command).not.toContain("/synergy/note/")
      expect(prepared?.extraReadRoots).toHaveLength(1)
    })
  })

  test("cleans staged files when setup fails before the child is spawned", async () => {
    await withNote("reviewed", async (noteID) => {
      const bash = await BashTool.init()
      let stagingRoot: string | undefined

      await expect(
        bash.execute(
          {
            command: `cat /synergy/note/${noteID}`,
            description: "Fail after staging",
          },
          {
            ...baseContext,
            metadata: () => {
              throw new Error("metadata unavailable")
            },
            extra: {
              sandboxPrepare: async (input: { command: string; extraReadRoots: string[] }) => {
                stagingRoot = input.extraReadRoots[0]
                return {
                  command: Shell.acceptable(),
                  args: ["-c", input.command],
                  sandboxed: false,
                }
              },
            },
          },
        ),
      ).rejects.toThrow("metadata unavailable")

      expect(stagingRoot).toBeString()
      expect(await Bun.file(stagingRoot!).exists()).toBe(false)
    })
  })

  test("leaves remote Link commands virtual and does not materialize local files", async () => {
    let forwarded: SynergyLinkBash.ExecutePayload | undefined
    let prepared = false
    const client: SynergyLinkClient.ExecutionClient = {
      async executeBash(_linkID, input) {
        forwarded = input
        return { title: "Remote", metadata: { backend: "remote", exit: 0 }, output: "remote" }
      },
      async executeProcess(): Promise<SynergyLinkProcess.Result> {
        throw new Error("unexpected process execution")
      },
      async executeSession(): Promise<SynergyLinkSession.Result> {
        throw new Error("unexpected session execution")
      },
    }
    SynergyLinkExecution.setClient(client)
    SynergyLinkExecution.upsertSession({
      linkID: "link_test",
      targetAgentID: "remote-agent",
      sessionID: "session_test",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    try {
      const bash = await BashTool.init()
      const command = "cat /synergy/note/nte_remote"
      const result = await bash.execute(
        { command, description: "Read remote note path", linkID: "link_test" },
        {
          ...baseContext,
          extra: {
            sandboxPrepare: async () => {
              prepared = true
              throw new Error("local sandbox should not be prepared")
            },
          },
        },
      )

      expect(result.metadata.backend).toBe("remote")
      expect(forwarded?.command).toBe(command)
      expect(prepared).toBe(false)
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })
})
