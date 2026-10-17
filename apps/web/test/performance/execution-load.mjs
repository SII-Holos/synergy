import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"

const [repository, output, size = "20", admissionMode = "paced"] = process.argv.slice(2)
const repo = path.resolve(repository),
  home = path.resolve(output),
  roots = Number(size)
if (
  !home.startsWith(path.resolve(tmpdir()) + path.sep) ||
  ![1, 5, 20].includes(roots) ||
  !["paced", "burst"].includes(admissionMode)
)
  throw Error("Use a fresh temporary home, 1, 5, or 20 roots, and paced or burst admission")
if (await Bun.file(path.join(home, "execution-load.json")).exists()) throw Error("Fixture already exists")
await mkdir(home, { recursive: true })
process.env.SYNERGY_HOME = home
process.env.SYNERGY_CWD = home
process.env.SYNERGY_CONFIG_CONTENT = "{}"
process.env.MODELS_DEV_API_JSON = path.join(repo, "packages/testing/fixtures/models-api.json")
process.env.SYNERGY_DISABLE_MODELS_FETCH = "true"
process.env.SYNERGY_DISABLE_DEFAULT_PLUGINS = "true"
process.env.SYNERGY_DISABLE_LSP_DOWNLOAD = "1"
process.env.SYNERGY_DISABLE_BUILTIN_MCP = "1"
const requests = [],
  failures = [],
  samples = []
let active = 0,
  peak = 0
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "GET") return Response.json({ data: [] })
    const input = await request.json()
    if (new URL(request.url).pathname.endsWith("/embeddings")) {
      const values = Array.isArray(input.input) ? input.input : [input.input]
      return Response.json({
        data: values.map((_, index) => ({
          index,
          object: "embedding",
          embedding: Array.from({ length: 384 }, (_, i) => +(i === 0)),
        })),
        model: input.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      })
    }
    const auxiliary = input.model === "fixture-aux"
    const read = input.tools?.find((tool) => tool.function?.name === "read")
    const hadTool = input.messages?.some((message) => message.role === "tool")
    const useTool = !auxiliary && !hadTool && !!read
    requests.push({ time: Date.now(), auxiliary, tool: useTool })
    const text = auxiliary ? "Performance fixture" : "Fixture completed with deterministic model output."
    if (!input.stream)
      return Response.json({
        id: crypto.randomUUID(),
        object: "chat.completion",
        created: 1,
        model: input.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    active++
    peak = Math.max(peak, active)
    return new Response(
      new ReadableStream({
        async start(controller) {
          const send = (delta, reason = null) =>
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
              ),
            )
          try {
            send({ role: "assistant" })
            if (useTool) {
              send({
                tool_calls: [
                  {
                    index: 0,
                    id: "fixture-read",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ filePath: "README.md" }) },
                  },
                ],
              })
              send({}, "tool_calls")
            } else {
              for (let i = 0; i < (auxiliary ? 1 : 20); i++) {
                if (request.signal.aborted) break
                send({ content: `${text} ${i}\n` })
                if (!auxiliary) await Bun.sleep(100)
              }
              send({}, "stop")
            }
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          } catch (error) {
            if (!request.signal.aborted) failures.push(String(error))
          } finally {
            active--
          }
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  },
})
const load = (file) => import(path.join(repo, file))
const { PresetRuntimeHandle } = await load("packages/presets/src/server/runtime-handle.ts")
const { createLocalHost } = await load("packages/local-runtime/src/host.ts")
const { createSynergyClient } = await load("packages/sdk/js/src/client.ts")
const { Scope } = await load("packages/harness/src/scope/index.ts")
const { ScopeContext } = await load("packages/harness/src/scope/context.ts")
const { Session } = await load("packages/harness/src/session/index.ts")
const { PrimaryAgentIdentity } = await load("packages/harness/src/agent/primary-identity.ts")
const { Identifier } = await load("packages/harness/src/id/id.ts")
const { Cortex, CortexConcurrency } = await load("packages/harness/src/cortex/index.ts")
const { AgentTurn } = await load("packages/harness/src/session/agent-turn/index.ts")
const { ObservabilityStore } = await load("packages/harness/src/observability/store.ts")
const runtime = await PresetRuntimeHandle.open({
  host: createLocalHost({ home }),
  mode: "server",
  network: { hostname: "127.0.0.1", port: 0 },
  webAppDirectory: path.join(repo, "apps/web/dist"),
})
const client = createSynergyClient({ baseUrl: runtime.server.url.toString() })
const start = Date.now(),
  sessions = [],
  tasks = [],
  completions = []
const admission = Promise.withResolvers()
let sampler, deadlineTimer, browser
const deadline = new Promise((_, reject) => {
  deadlineTimer = setTimeout(() => reject(Error("Execution load did not drain within five minutes")), 300000)
})
try {
  for (const [domain, config] of [
    [
      "providers",
      {
        enabled_providers: ["fixture"],
        provider: {
          fixture: {
            name: "Performance fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture-only" },
            models: {
              "fixture-chat": { name: "Fixture", tool_call: true, limit: { context: 128000, output: 8192 } },
              "fixture-aux": { name: "Fixture auxiliary", tool_call: true, limit: { context: 128000, output: 4096 } },
            },
          },
        },
      },
    ],
    ["models", { model: "fixture/fixture-chat", nano_model: "fixture/fixture-aux" }],
    [
      "general",
      { embedding: { apiKey: "fixture-only", baseURL: `${provider.url.origin}/v1`, model: "fixture-embedding" } },
    ],
  ])
    await client.config.domain.update({ domain, configDomainUpdateInput: { config } }, { throwOnError: true })
  await Promise.race([
    deadline,
    runtime.run(async () => {
      sampler = setInterval(
        () =>
          samples.push({
            time: Date.now() - start,
            modelActive: active,
            modelRequests: requests.length,
            memory: process.memoryUsage(),
            agent: AgentTurn.stats(),
            cortex: CortexConcurrency.globalStatus(),
            terminal: Cortex.list().filter((task) => !["queued", "running"].includes(task.status)).length,
            telemetry: ObservabilityStore.stats(),
          }),
        1000,
      )
      const scopes = []
      for (let i = 0; i < Math.min(5, roots); i++) {
        const directory = path.join(home, `scope-${i}`)
        await mkdir(directory, { recursive: true })
        await Bun.write(path.join(directory, "README.md"), "Deterministic performance tool fixture.\n")
        scopes.push(await Scope.resolve({ directory }))
      }
      if (admissionMode === "paced") admission.resolve()
      for (let i = 0; i < roots; i++)
        await ScopeContext.provide({
          scope: scopes[i % scopes.length],
          fn: async () => {
            const session = await Session.create({ title: `Execution fixture ${i}` })
            const messageID = Identifier.ascending("message")
            sessions.push({ id: session.id, scopeID: session.scope.id })
            const operation = admission.promise
              .then(() =>
                client.session.prompt(
                  {
                    sessionID: session.id,
                    scopeID: session.scope.id,
                    messageID,
                    model: { providerID: "fixture", modelID: "fixture-chat" },
                    agent: PrimaryAgentIdentity.names.general,
                    parts: [{ type: "text", text: "Read README.md and return a deterministic fixture result." }],
                  },
                  { throwOnError: true },
                ),
              )
              .then((result) => {
                if (!result.data?.info) failures.push("Root request did not return an assistant message")
                if (result.data?.info.error) failures.push(JSON.stringify(result.data.info.error))
                return result.data
              })
              .catch((error) => {
                failures.push(String(error))
                return null
              })
            completions.push(operation)
            for (let j = 0; j < 4; j++)
              tasks.push(
                await (admissionMode === "burst" ? Cortex.prepare : Cortex.launch)({
                  description: `Fixture child ${i}.${j}`,
                  prompt: "Read README.md and return a deterministic fixture result.",
                  agent: "explore",
                  parentSessionID: session.id,
                  parentMessageID: messageID,
                  model: { providerID: "fixture", modelID: "fixture-chat" },
                  notifyParentOnComplete: false,
                  visibility: "visible",
                  output: { mode: "final_response" },
                }),
              )
          },
        })
      console.log(`LOAD_SUBMITTED ${sessions.length} roots ${tasks.length} children`)
      if (process.env.SYNERGY_PERF_BROWSER === "1") {
        if (admissionMode !== "burst") throw Error("Browser execution acceptance requires burst admission")
        await Bun.write(
          path.join(home, "execution-manifest.json"),
          JSON.stringify({
            origin: runtime.server.url.origin,
            sessions: sessions.map((session) => ({
              ...session,
              route: `/${Buffer.from(session.scopeID).toString("base64url")}/session/${session.id}`,
            })),
          }),
        )
        browser = Bun.spawn([process.execPath, path.join(import.meta.dir, "execution-browser.mjs"), repo, home], {
          stdout: Bun.file(path.join(home, "execution-browser.log")),
          stderr: Bun.file(path.join(home, "execution-browser-errors.log")),
        })
        const readyUntil = Date.now() + 60000
        while (!(await Bun.file(path.join(home, "execution-browser-ready")).exists())) {
          if (browser.exitCode !== null || Date.now() > readyUntil)
            throw Error("Execution browser did not become ready")
          await Bun.sleep(100)
        }
      }
      admission.resolve()
      if (admissionMode === "burst")
        await Promise.all(
          tasks.map((task) =>
            ScopeContext.provide({
              scope: scopes.find(
                (scope) => scope.id === sessions.find((session) => session.id === task.parentSessionID).scopeID,
              ),
              fn: () => Cortex.start(task.id).catch((error) => failures.push(String(error))),
            }),
          ),
        )
      await Promise.all(completions)
      while (Cortex.list().some((task) => ["queued", "running"].includes(task.status))) {
        await Bun.sleep(500)
      }
      await Cortex.drain()
      const executionDurationMs = Date.now() - start
      if (browser) {
        await Bun.write(path.join(home, "execution-browser-stop"), "complete")
        if (await browser.exited) failures.push("Execution browser failed")
      }
      for (const task of Cortex.list())
        if (task.status !== "completed") failures.push(`${task.status}: ${task.error ?? "no detail"}`)
      let tools = 0
      for (const session of [...sessions, ...Cortex.list().map((task) => ({ id: task.sessionID }))]) {
        const info = await Session.get(session.id)
        await ScopeContext.provide({
          scope: info.scope,
          fn: async () => {
            for (const message of await Session.messages({ sessionID: session.id }))
              tools += message.parts.filter((part) => part.type === "tool" && part.state.status === "completed").length
          },
        })
      }
      console.log(
        JSON.stringify({
          roots,
          children: tasks.length,
          peakModelRequests: peak,
          requests: requests.length,
          completedTools: tools,
          failures: failures.length,
        }),
      )
      await Bun.write(
        path.join(home, "execution-load.json"),
        JSON.stringify(
          {
            roots,
            admissionMode,
            children: tasks.length,
            durationMs: Date.now() - start,
            executionDurationMs,
            browser: !!browser,
            peakModelRequests: peak,
            requests,
            completedTools: tools,
            samples,
            failures,
          },
          null,
          2,
        ),
      )
      if (failures.length || tools < roots + tasks.length)
        throw Error("Execution fixture failed; inspect its private report")
    }),
  ])
} catch (error) {
  failures.push(String(error))
  throw error
} finally {
  clearTimeout(deadlineTimer)
  clearInterval(sampler)
  await Bun.write(
    path.join(home, "execution-load-partial.json"),
    JSON.stringify(
      { roots, admissionMode, sessions: sessions.length, children: tasks.length, requests, samples, failures },
      null,
      2,
    ),
  )
  admission.resolve()
  if (browser && browser.exitCode === null) {
    await Bun.write(path.join(home, "execution-browser-stop"), "stopping")
    await browser.exited
  }
  await runtime.close()
  provider.stop(true)
}
