import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import type { Argv } from "yargs"
import type { CommandModule } from "yargs"
import { tmpdir } from "../fixture/fixture"
import { DebugCommand } from "../../src/cli/cmd/debug"
import { ConfigCommand } from "../../src/cli/cmd/debug/config"
import { AgentCommand } from "../../src/cli/cmd/debug/agent"
import { FileCommand } from "../../src/cli/cmd/debug/file"
import { LSPCommand, SymbolsCommand, DocumentSymbolsCommand } from "../../src/cli/cmd/debug/lsp"
import { RipgrepCommand } from "../../src/cli/cmd/debug/ripgrep"
import { ScrapCommand } from "../../src/cli/cmd/debug/scrap"
import { SkillCommand } from "../../src/cli/cmd/debug/skill"
import { SnapshotCommand } from "../../src/cli/cmd/debug/snapshot"

function handlerArgs<T extends Record<string, unknown>>(partial: T) {
  return { _: [] as Array<string | number>, $0: "synergy", ...partial }
}

function runHandler(command: { handler?: unknown }) {
  return (command.handler as (args: never) => Promise<void>).bind(command)
}

function runBuilder(command: { builder?: unknown }) {
  return (command.builder as (argv: Argv) => Argv)(yargs())
}

async function runCommandModule(command: CommandModule, args: string[]): Promise<string> {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  const originalLog = console.log
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as never
  console.log = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "))
  }
  try {
    const argv = yargs().exitProcess(false).scriptName("synergy").command(command).demandCommand().help(false)
    await argv.parseAsync(args, {})
  } finally {
    process.stdout.write = original as never
    console.log = originalLog
  }
  return lines.join("")
}

async function captureStream(write: NodeJS.WriteStream, fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = write.write.bind(write)
  write.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as never
  try {
    await fn()
  } finally {
    write.write = original as never
  }
  return lines.join("")
}

describe("debug command tree", () => {
  test("registers every debug subcommand", async () => {
    const argv = runBuilder(DebugCommand)
    const help = await argv.getHelp()
    for (const expected of ["config", "file", "lsp", "rg", "scrap", "skill", "snapshot", "agent", "paths", "wait"]) {
      expect(help).toContain(expected)
    }
  })

  test("debug config prints resolved configuration inside a scope", async () => {
    await using tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const output = await captureStream(process.stdout, () => runHandler(ConfigCommand)(handlerArgs({}) as never))
      expect(JSON.parse(output)).toMatchObject({ default_agent: expect.any(String) })
    } finally {
      process.chdir(cwd)
    }
  })

  test("debug scrap lists scopes as JSON", async () => {
    await using tmp = await tmpdir({ git: true })
    const { Scope } = await import("../../src/scope")
    await Scope.fromDirectory(tmp.path)
    const output = await captureStream(process.stdout, () => runHandler(ScrapCommand)(handlerArgs({}) as never))
    expect(JSON.parse(output)).toEqual(expect.any(Array))
  })

  test("debug skill lists skills as JSON", async () => {
    await using tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const output = await captureStream(process.stdout, () => runHandler(SkillCommand)(handlerArgs({}) as never))
      expect(JSON.parse(output)).toEqual(expect.any(Array))
    } finally {
      process.chdir(cwd)
    }
  })

  test("debug agent rejects unknown agents and reports the list command", async () => {
    await using tmp = await tmpdir({ git: true })
    const cwd = process.cwd()
    process.chdir(tmp.path)
    const stderr: string[] = []
    const originalExit = process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
      return true
    }) as never
    process.exit = (() => {
      throw new Error("exit called")
    }) as never
    try {
      await expect(
        runHandler(AgentCommand)(handlerArgs({ name: "definitely-missing-agent" }) as never),
      ).rejects.toThrow("exit called")
    } finally {
      process.chdir(cwd)
      process.exit = originalExit
      process.stderr.write = originalStderr as never
    }
    expect(stderr.join("")).toContain("Agent definitely-missing-agent not found")
    expect(stderr.join("")).toContain("agent list")
  })

  test("debug file tree runs in-process through yargs", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(`${dir}/a.txt`, "a")
        await Bun.write(`${dir}/b.txt`, "b")
      },
    })
    const cwd = process.cwd()
    process.chdir(tmp.path)
    try {
      const output = await runCommandModule(FileCommand, ["file", "tree", "."])
      expect(output).toContain("a.txt")
      expect(output).toContain("b.txt")
    } finally {
      process.chdir(cwd)
    }
  })

  test("lsp builders register their positionals", () => {
    expect(runBuilder(LSPCommand)).toBeDefined()
    expect(runBuilder(SymbolsCommand)).toBeDefined()
    expect(runBuilder(DocumentSymbolsCommand)).toBeDefined()
  })

  test("ripgrep and snapshot builders register their subcommands", () => {
    expect(runBuilder(RipgrepCommand)).toBeDefined()
    expect(runBuilder(SnapshotCommand)).toBeDefined()
  })
})
