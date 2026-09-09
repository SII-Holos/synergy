import "../../src/external-agent/adapter/openclaw"
import { expect, spyOn, test } from "bun:test"
import { ExternalAgent } from "../../src/external-agent/bridge"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { chmod } from "node:fs/promises"
import path from "node:path"

test("OpenClaw adapter preserves turn arguments and parses real process stderr/stdout protocol variants", async () => {
  await using tmp = await tmpdir()
  const binary = path.join(tmp.path, "openclaw")
  const argsFile = path.join(tmp.path, "arguments.json")
  await Bun.write(
    binary,
    `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("OpenClaw fixture 1.0\\nignored"); process.exit(0) }\nawait Bun.write(process.env.ARGUMENTS_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.stderr.write(process.env.REPLY_STDERR ?? "");\nprocess.stdout.write(process.env.REPLY_STDOUT ?? "");\nprocess.exit(Number(process.env.REPLY_CODE ?? 0));\n`,
  )
  await chmod(binary, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${tmp.path}${path.delimiter}${previousPath ?? ""}`
  const sessionID = `openclaw-${crypto.randomUUID()}`
  const originalSpawn = Bun.spawn
  const which = spyOn(Bun, "which").mockImplementation((command) => (command === "openclaw" ? binary : null))
  const spawn = spyOn(Bun, "spawn").mockImplementation((command, options = undefined) => {
    if (!Array.isArray(command)) throw new Error("unexpected process request")
    if (command[0] === "openclaw") return originalSpawn([binary, ...command.slice(1)], options as never) as never
    if (command[0] !== "sh") throw new Error("unexpected external command")
    return originalSpawn(command, options as never) as never
  })
  const adapter = ExternalAgent.getAdapter("openclaw", sessionID)!
  try {
    expect(await adapter.discover()).toMatchObject({ available: true, path: binary, version: "OpenClaw fixture 1.0" })
    const turn = { sessionID, prompt: "user's exact prompt", instructions: "instruction", taskContext: "task context" }
    async function run(stderr: string, stdout = "", code = 0) {
      await adapter.start({
        cwd: tmp.path,
        config: { timeout: 7, thinking: "low" },
        env: {
          PATH: process.env.PATH!,
          ARGUMENTS_FILE: argsFile,
          REPLY_STDERR: stderr,
          REPLY_STDOUT: stdout,
          REPLY_CODE: String(code),
        },
      })
      const events: ExternalAgent.BridgeEvent[] = []
      for await (const event of adapter.turn(turn)) events.push(event)
      return events
    }
    expect(
      await run(
        "\u001b[32mplugin startup\u001b[0m\n" +
          JSON.stringify({
            meta: { finalAssistantVisibleText: "answer", agentMeta: { usage: { input: 11, output: 3 } } },
          }) +
          "\ntrailing log",
      ),
    ).toEqual([
      { type: "text_delta", text: "answer" },
      { type: "turn_complete", usage: { inputTokens: 11, outputTokens: 3 } },
    ])
    const args: string[] = await Bun.file(argsFile).json()
    expect(args).toEqual([
      "agent",
      "--local",
      "--json",
      "--session-id",
      `synergy-${sessionID}`,
      "--timeout",
      "7",
      "--thinking",
      "low",
      "-m",
      "instruction\n\ntask context\n\nuser's exact prompt",
    ])
    expect(
      await run(
        "noise without JSON",
        JSON.stringify({ payloads: [{ text: "one" }, { mediaUrl: "image" }, { text: "two" }] }),
      ),
    ).toEqual([
      { type: "text_delta", text: "one\ntwo" },
      { type: "turn_complete", usage: undefined },
    ])
    expect(await run(JSON.stringify({ meta: { aborted: true } }))).toEqual([
      { type: "turn_complete", usage: undefined },
      { type: "error", message: "OpenClaw turn was aborted" },
    ])
    expect(await run("failure text", "", 2)).toEqual([
      { type: "error", message: "failure text" },
      { type: "turn_complete" },
    ])
    expect(await run("{bad JSON")).toEqual([
      { type: "error", message: "OpenClaw returned no parseable response (exit 0)" },
      { type: "turn_complete" },
    ])
    await adapter.interrupt()
    await adapter.shutdown()
    expect(adapter.started).toBe(false)
  } finally {
    spawn.mockRestore()
    which.mockRestore()
    await ExternalAgent.shutdownAdapter("openclaw", sessionID)
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})
