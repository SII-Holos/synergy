import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

const Request = z.object({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  input: z.union([z.string(), z.array(z.string())]).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).optional(),
})

export function startWorkbenchProvider(port = 0) {
  const journal: { kind: "chat" | "auxiliary" | "embedding"; streamed: boolean; chunks: number }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method === "GET") {
        if (pathname === "/journal") return Response.json(journal)
        return Response.json({
          object: "list",
          data: ["fixture-chat", "fixture-aux"].map((id) => ({ id, object: "model", owned_by: "fixture" })),
        })
      }
      const input = Request.parse(await request.json())
      if (pathname.endsWith("/embeddings")) {
        journal.push({ kind: "embedding", streamed: false, chunks: 0 })
        const values = Array.isArray(input.input) ? input.input : [input.input ?? ""]
        return Response.json({
          object: "list",
          data: values.map((_, index) => ({
            object: "embedding",
            index,
            embedding: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
          })),
          model: "fixture-embedding",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        })
      }
      const auxiliary = input.model === "fixture-aux"
      const record = {
        kind: auxiliary ? ("auxiliary" as const) : ("chat" as const),
        streamed: !!input.stream,
        chunks: 0,
      }
      journal.push(record)
      const long = input.messages?.some(
        (message) => message.role === "user" && (JSON.stringify(message.content) ?? "").includes("[long]"),
      )
      const text = auxiliary
        ? "Workbench acceptance"
        : long
          ? Array.from(
              { length: 35 },
              (_, i) =>
                `### 第 ${i + 1} 节\n\n这是用于阅读与滚动验收的合成回复。输入框保持在底部，向上阅读时不会被拉回。每段内容都有稳定的位置，主题和字体遵循当前设置。\n\n`,
            ).join("")
          : "已收到测试任务。\n\n这是一条通过真实服务器、SDK 与消息流呈现的合成回复。\n\n- 输入位置保持稳定\n- 草稿按任务保存\n- 浅色与深色使用同一套语义角色"
      if (!input.stream)
        return Response.json({
          id: "fixture-response",
          object: "chat.completion",
          created: 1,
          model: input.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                ),
              )
            }
            try {
              send({ role: "assistant" })
              if (!auxiliary) await Bun.sleep(1200)
              const chunks = text.match(/.{1,90}/gs) ?? []
              for (const content of chunks) {
                if (request.signal.aborted) break
                send({ content })
                record.chunks++
                if (!auxiliary) await Bun.sleep(long ? 1000 : 120)
              }
              send({}, "stop")
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            } catch (error) {
              if (!request.signal.aborted) controller.error(error)
            }
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  return { server, journal }
}

if (import.meta.main) {
  const [home, origin, port] = process.argv.slice(2)
  if (!home || !origin || !port) throw new Error("Usage: provider.ts <isolated-home> <server-origin> <provider-port>")
  const url = new URL(origin)
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Fixture server must be local HTTP")
  const selectedHome = await realpath(home)
  if (selectedHome === (await realpath(homedir()))) throw new Error("Fixture cannot use the user home")
  const client = createSynergyClient({ baseUrl: url.origin })
  const { data: paths } = await client.path.get({ scopeID: "home" }, { throwOnError: true })
  if (!paths || (await realpath(paths.home)) !== selectedHome)
    throw new Error("Server home does not match the selected isolated home")
  const providerPort = Number(port)
  if (!Number.isInteger(providerPort) || providerPort < 1024 || providerPort > 65535)
    throw new Error("Invalid provider port")
  const { server, journal } = startWorkbenchProvider(providerPort)
  const close = () => {
    server.stop(true)
    console.log(JSON.stringify({ journal }))
    process.exit(0)
  }
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  await client.config.domain.update(
    {
      domain: "providers",
      configDomainUpdateInput: {
        config: {
          provider: {
            fixture: {
              name: "Workbench fixture",
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { baseURL: `${server.url.origin}/v1`, apiKey: "fixture-only" },
              models: {
                "fixture-chat": { name: "Workbench Chat", tool_call: true, limit: { context: 128000, output: 8192 } },
                "fixture-aux": {
                  name: "Workbench Auxiliary",
                  tool_call: true,
                  limit: { context: 128000, output: 4096 },
                },
              },
            },
          },
        },
      },
    },
    { throwOnError: true },
  )
  await client.config.domain.update(
    {
      domain: "models",
      configDomainUpdateInput: { config: { model: "fixture/fixture-chat", nano_model: "fixture/fixture-aux" } },
    },
    { throwOnError: true },
  )
  await client.config.domain.update(
    {
      domain: "general",
      configDomainUpdateInput: {
        config: {
          embedding: { apiKey: "fixture-only", baseURL: `${server.url.origin}/v1`, model: "fixture-embedding" },
        },
      },
    },
    { throwOnError: true },
  )
  console.log("Workbench fixture ready; chat, auxiliary and embedding requests are recorded separately.")
}
