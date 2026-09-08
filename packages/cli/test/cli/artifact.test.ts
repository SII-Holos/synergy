import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

const binary = process.env.SYNERGY_TEST_ARTIFACT_BIN
const installed = process.env.SYNERGY_TEST_ARTIFACT_INSTALL

for (const mode of ["complete", "tool", "read", "budget", "timeout", "permission"] as const)
  test.skipIf(!binary && !installed)(
    `installed runtime artifact preserves ${mode} outcome outside the repository`,
    async () => {
      const isolation = await createIsolatedTestEnv()
      delete isolation.env.NODE_PATH
      delete isolation.env.NODE_OPTIONS
      delete isolation.env.MODELS_DEV_API_JSON
      delete isolation.env.SYNERGY_OBSERVABILITY_INLINE
      const sideEffect = path.join(isolation.env.SYNERGY_TEST_ROOT!, "must-not-exist")
      const inputFile = path.join(isolation.env.SYNERGY_TEST_ROOT!, "research", "fixture.txt")
      const fileContent = "Installed runtime file evidence 7bfc91"
      let readObserved = false
      let budgetObserved = false
      let requests = 0
      let responseMode: typeof mode = mode
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requests++
          const input = await request.json()
          readObserved ||= input.messages.some(
            (message: { role: string; content: unknown }) =>
              message.role === "tool" && JSON.stringify(message.content).includes(fileContent),
          )
          budgetObserved ||= JSON.stringify(input.messages).includes("CRITICAL - MAXIMUM STEPS REACHED")
          const toolResponse =
            responseMode === "permission" ||
            ((responseMode === "tool" || responseMode === "read") &&
              !input.messages.some((message: { role: string }) => message.role === "tool"))
          if (responseMode === "timeout" && input.stream) await Bun.sleep(5000)
          if (!input.stream)
            return Response.json({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 0,
              model: "test-model",
              choices: [
                { index: 0, message: { role: "assistant", content: "Research complete" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            })
          const frames = [
            {
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 0,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: toolResponse
                    ? {
                        role: "assistant",
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_permission",
                            type: "function",
                            function: {
                              name: responseMode === "read" ? "read" : "bash",
                              arguments: JSON.stringify(
                                responseMode === "read"
                                  ? { filePath: inputFile }
                                  : {
                                      command: `touch ${sideEffect}`,
                                      description: "Create test marker",
                                    },
                              ),
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "Research complete" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 0,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: toolResponse ? "tool_calls" : "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            },
          ]
          return new Response(
            frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          )
        },
      })
      try {
        const command = installed
          ? [process.execPath, path.join(installed, "node_modules/.bin/synergy")]
          : await (async () => {
              const installation = path.join(isolation.env.SYNERGY_TEST_ROOT!, "installation")
              await fs.cp(path.dirname(path.dirname(binary!)), installation, { recursive: true })
              return [path.join(installation, "bin", path.basename(binary!))]
            })()
        const workspace = path.join(isolation.env.SYNERGY_TEST_ROOT!, "research")
        await fs.mkdir(workspace, { recursive: true })
        await Bun.write(inputFile, fileContent)
        const config = {
          agent: mode === "budget" ? { synergy: { steps: 1 } } : undefined,
          model: "test/test-model",
          controlProfile: mode === "tool" || mode === "read" ? "full_access" : "guarded",
          permission: { bash: "ask" },
          execution: { agentWorkers: 1, agentWorkerMinIdle: 0 },
          provider: {
            test: {
              name: "Fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              models: { "test-model": { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } },
              options: { apiKey: "fixture", baseURL: server.url.toString() },
            },
          },
        }
        const child = Bun.spawn(
          [
            ...command,
            "send",
            "Return a brief result",
            "--format",
            "json",
            "--non-interactive",
            "--timeout",
            mode === "timeout" ? "1" : "20",
          ],
          {
            cwd: workspace,
            env: { ...isolation.env, SYNERGY_CWD: workspace, SYNERGY_CONFIG_CONTENT: JSON.stringify(config) },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const expectedCode = mode === "timeout" ? 3 : mode === "permission" ? 4 : 0
        let diagnostics = ""
        if (code !== expectedCode) {
          const logDirectory = path.join(isolation.env.SYNERGY_TEST_HOME!, ".synergy", "log")
          for (const filename of await fs.readdir(logDirectory).catch(() => [] as string[])) {
            diagnostics += (await Bun.file(path.join(logDirectory, filename)).text()).slice(-18000)
          }
        }
        expect(code, stderr + "\n" + stdout + "\n" + diagnostics).toBe(expectedCode)
        const events = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(events.at(-1)).toMatchObject({
          type: "result",
          exitCode: expectedCode,
          result: {
            run: {
              status: expectedCode === 0 ? "completed" : "cancelled",
              ...(expectedCode === 0 ? { recording: "complete" } : {}),
            },
          },
        })
        if (mode !== "timeout") expect(requests).toBeGreaterThan(0)
        if (mode === "read") expect(readObserved).toBe(true)
        if (mode === "budget") expect(budgetObserved).toBe(true)
        if (mode === "complete") {
          const archive = path.join(workspace, "rollout.zip")
          async function run(args: string[]) {
            const child = Bun.spawn([...command, ...args], {
              cwd: workspace,
              env: { ...isolation.env, SYNERGY_CWD: workspace, SYNERGY_CONFIG_CONTENT: JSON.stringify(config) },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            })
            const [stdout, stderr, code] = await Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
              child.exited,
            ])
            expect(code, stderr + stdout).toBe(0)
            return stdout
          }
          const transcript = await run(["export", events.at(-1).sessionID])
          expect(JSON.stringify(JSON.parse(transcript))).toContain("Research complete")
          const transcriptFile = path.join(workspace, "transcript.json")
          await Bun.write(transcriptFile, transcript)
          const importedTranscript = await run(["import", transcriptFile])
          const transcriptID = importedTranscript.match(/Imported session: (\S+)/)?.[1]
          expect(transcriptID).toBeDefined()
          expect(JSON.stringify(JSON.parse(await run(["export", transcriptID!])))).toContain("Research complete")
          await run([
            "export",
            events.at(-1).sessionID,
            "--format",
            "rollout",
            "--run",
            events.at(-1).runID,
            "--output",
            archive,
          ])
          expect(new Uint8Array(await Bun.file(archive).arrayBuffer()).subarray(0, 2)).toEqual(new Uint8Array([80, 75]))
          const imported = await run(["import", archive])
          const importedID = imported.match(/Imported session: (\S+)/)?.[1]
          expect(importedID).toBeDefined()
          const roundtrip = await run(["export", importedID!])
          expect(JSON.stringify(JSON.parse(roundtrip))).toContain("Research complete")
        }
        if (mode === "timeout" || mode === "permission") {
          responseMode = "complete"
          const resumed = Bun.spawn(
            [
              ...command,
              "send",
              "Continue after cancellation",
              "--session",
              events.at(-1).sessionID,
              "--format",
              "json",
              "--non-interactive",
              "--timeout",
              "20",
            ],
            {
              cwd: workspace,
              env: { ...isolation.env, SYNERGY_CWD: workspace, SYNERGY_CONFIG_CONTENT: JSON.stringify(config) },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          const [resumedOutput, resumedError, resumedCode] = await Promise.all([
            new Response(resumed.stdout).text(),
            new Response(resumed.stderr).text(),
            resumed.exited,
          ])
          expect(resumedCode, resumedError + resumedOutput).toBe(0)
          const result = JSON.parse(resumedOutput.trim().split("\n").at(-1)!)
          expect(result).toMatchObject({
            type: "result",
            result: { run: { status: "completed", recording: "complete" } },
          })
          expect(result.runID).not.toBe(events.at(-1).runID)
        }
        expect(await Bun.file(sideEffect).exists()).toBe(mode === "tool")
        expect(
          await Bun.file(path.join(isolation.env.SYNERGY_TEST_HOME!, ".synergy", "daemon", "server.lock")).exists(),
        ).toBe(false)
      } finally {
        await isolation.dispose()
      }
    },
    45_000,
  )
