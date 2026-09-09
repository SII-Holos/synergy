import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import "../../src/external-agent/adapter/codex"
import { ExternalAgent } from "../../src/external-agent/bridge"

test("Codex subprocess preserves protocol events, thread isolation and native auth boundaries", async () => {
  await using directory = await tmpdir()
  const program = path.join(directory.path, "codex-fixture.ts")
  await Bun.write(
    program,
    `#!${process.execPath}\n${await Bun.file(path.join(import.meta.dir, "fixtures/codex-cli.ts")).text()}`,
  )
  const executable = process.platform === "win32" ? path.join(directory.path, "codex-fixture.cmd") : program
  if (process.platform === "win32") await Bun.write(executable, `@"${process.execPath}" "${program}" %*\r\n`)
  else await chmod(program, 0o755)

  const owner = crypto.randomUUID()
  const adapter = ExternalAgent.getAdapter("codex", owner)!
  try {
    await adapter.start({
      cwd: directory.path,
      env: { SYNERGY_CODEX_API_KEY: "fixture-only-key", UNFORWARDED_FIXTURE_VALUE: "fixture-only-value" },
      config: { path: executable, nativeAuth: true, model: "fixture-model", controlProfile: "guarded" },
    })
    expect(adapter.started).toBe(true)
    async function turn(sessionID: string) {
      const events: ExternalAgent.BridgeEvent[] = []
      for await (const event of adapter.turn({
        sessionID,
        prompt: "Fixture request",
        instructions: "Fixture project instructions",
        taskContext: "Fixture delegation context",
      })) {
        events.push(event)
      }
      const invocation = (await Bun.file(path.join(directory.path, "invocation.json")).json()) as {
        args: string[]
        prompt: string
        apiKey: string | null
        unforwarded: string | null
      }
      return { events, invocation }
    }

    const first = await turn("session-one")
    expect(first.events).toEqual([
      { type: "tool_start", id: "shell-1", name: "shell", input: JSON.stringify({ command: "fixture command" }) },
      { type: "tool_end", id: "shell-1", name: "shell", result: "fixture output", error: "exit code 2" },
      { type: "text_delta", text: "Fixture answer" },
      { type: "turn_complete", usage: { inputTokens: 12, outputTokens: 7 } },
    ])
    expect(first.invocation.args).toEqual([
      "exec",
      "--json",
      "--model",
      "fixture-model",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      directory.path,
      "-",
    ])
    expect(first.invocation.prompt).toContain(
      "<project-instructions>\nFixture project instructions\n</project-instructions>",
    )
    expect(first.invocation.prompt).toContain("<task-context>\nFixture delegation context\n</task-context>")
    expect(first.invocation.prompt.endsWith("Fixture request")).toBe(true)
    expect(first.invocation.apiKey).toBeNull()
    expect(first.invocation.unforwarded).toBeNull()

    const resumed = await turn("session-one")
    expect(resumed.events).toEqual(first.events)
    expect(resumed.invocation.args).toEqual([
      "exec",
      "resume",
      "thread-fixture",
      "--json",
      "--model",
      "fixture-model",
      "--skip-git-repo-check",
      "-",
    ])
    const separate = await turn("session-two")
    expect(separate.invocation.args).toEqual(first.invocation.args)
    expect(separate.events).toEqual(first.events)
  } finally {
    await ExternalAgent.shutdownAdapter("codex", owner)
  }
  expect(adapter.started).toBe(false)
}, 10_000)
