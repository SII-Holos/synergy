import { expect, test } from "bun:test"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

for (const signal of ["SIGTERM", "SIGINT"] as const)
  test(`local send drains ${signal} in its owning Scope and retains accounting`, async () => {
    const isolation = await createIsolatedTestEnv()
    const started = Promise.withResolvers<void>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const input = await request.json()
        if (!input.stream)
          return Response.json({
            id: "fixture",
            object: "chat.completion",
            created: 0,
            model: "fixture",
            choices: [{ index: 0, message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    id: "fixture",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "fixture",
                    choices: [
                      { index: 0, delta: { role: "assistant", content: "Retained prefix" }, finish_reason: null },
                    ],
                  })}\n\n`,
                ),
              )
              started.resolve()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const config = {
      model: "fixture/fixture",
      ...Object.fromEntries(
        ["nano", "mini", "mid", "thinking", "long_context", "creative", "vision"].map((role) => [
          `${role}_model`,
          "fixture/fixture",
        ]),
      ),
      execution: { agentWorkers: 1, agentWorkerMinIdle: 0 },
      provider: {
        fixture: {
          name: "Fixture",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { fixture: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "fixture", baseURL: server.url.toString() },
        },
      },
    }
    const child = Bun.spawn(
      [
        process.execPath,
        path.resolve(import.meta.dir, "../../src/index.ts"),
        "send",
        "Reply briefly",
        "--format",
        "json",
        "--non-interactive",
        "--timeout",
        "120",
      ],
      {
        cwd: isolation.env.SYNERGY_TEST_ROOT,
        env: { ...isolation.env, SYNERGY_CONFIG_CONTENT: JSON.stringify(config) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = new Response(child.stdout).text()
    const errors = new Response(child.stderr).text()
    try {
      await Promise.race([
        started.promise,
        child.exited.then(async (code) => {
          throw new Error(`Send exited before provider stream: ${code}\n${await errors}\n${await output}`)
        }),
      ])
      child.kill(signal)
      const [code, stdout, stderr] = await Promise.all([child.exited, output, errors])
      expect(code, stderr + stdout).toBe(130)
      const terminal = JSON.parse(stdout.trim().split("\n").at(-1)!)
      expect(terminal).toMatchObject({
        type: "result",
        outcome: "cancelled",
        exitCode: 130,
        result: { run: { status: "cancelled", recording: "partial" } },
      })
      expect(terminal.result.accounting.tokens.input.unknown).toBeGreaterThan(0)
      expect(stderr).not.toContain("No context found for scope")
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      server.stop(true)
      await isolation.dispose()
    }
  }, 45_000)
