export interface InstalledProviderDecision {
  sequence: number
  requestHash: string
  stream: boolean
  roles: string[]
  userIndex: number
  toolCount: number
  outputCount: number
  outputCallHashes: string[]
  toolCallHash: string | null
  emitsToolCall: boolean
}

export function installedProvider(observe?: (decision: InstalledProviderDecision) => void) {
  let sequence = 0
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as {
        stream?: boolean
        tools?: Array<{ function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }>
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
      }
      const user = input.messages.findLast(
        (message) => message.role === "user" && JSON.stringify(message.content).includes("Installed acceptance task"),
      )
      const contentText = (value: unknown): string => {
        if (typeof value === "string") return value
        if (Array.isArray(value)) return value.map(contentText).join("\n")
        if (value && typeof value === "object" && "text" in value) return String(value.text)
        return JSON.stringify(value)
      }
      const text = contentText(user?.content)
      const command = text?.match(/COMMAND_BEGIN\n([\s\S]+?)\nCOMMAND_END/)?.[1]
      const userIndex = user ? input.messages.indexOf(user) : -1
      const output = input.messages.slice(userIndex + 1).filter((message) => message.role === "tool")
      const call = Boolean(input.tools?.length && command && output.length === 0)
      const properties = input.tools?.find((tool) => tool.function?.name === "bash")?.function?.parameters?.properties
      const brief = properties && "description" in properties ? "description" : "workBrief"
      const markers = JSON.stringify(input.messages).match(/(?:FILE|ATTACHMENT)_[a-f0-9]{32}/g) ?? []
      const content = [...new Set(markers)].join(" ") || "Installed task"
      const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      const callID = call ? `call_${crypto.randomUUID()}` : undefined
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callID!,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command, [brief]: "Execute installed acceptance task" }),
                },
              },
            ],
          }
        : { role: "assistant", content }
      observe?.({
        sequence: ++sequence,
        requestHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex"),
        stream: input.stream ?? false,
        roles: input.messages.map((message) => message.role),
        userIndex,
        toolCount: input.tools?.length ?? 0,
        outputCount: output.length,
        outputCallHashes: output
          .slice(0, 32)
          .flatMap((message) =>
            typeof message.tool_call_id === "string"
              ? [new Bun.CryptoHasher("sha256").update(message.tool_call_id).digest("hex")]
              : [],
          ),
        toolCallHash: input.stream && callID ? new Bun.CryptoHasher("sha256").update(callID).digest("hex") : null,
        emitsToolCall: Boolean(input.stream && call),
      })
      if (!input.stream)
        return Response.json({
          id: "fixture",
          object: "chat.completion",
          created: 0,
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage,
        })
      return new Response(
        [
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "model",
            choices: [{ index: 0, delta, finish_reason: null }],
          },
          {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 0,
            model: "model",
            choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
            usage,
          },
        ]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
}
