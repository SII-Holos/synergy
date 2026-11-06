export function productProvider() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      const messages = body.messages as Array<{ role: string; content: unknown }>
      const text = (content: unknown): string => {
        if (typeof content === "string") return content
        if (Array.isArray(content)) return content.map(text).join("\n")
        if (content && typeof content === "object" && "text" in content) return String(content.text)
        return JSON.stringify(content)
      }
      const last = messages.findLastIndex(
        (message) => message.role === "user" && !text(message.content).startsWith("<runtime-context>"),
      )
      const user = text(messages[last]?.content ?? "")
      const commandIndex = messages.findLastIndex(
        (message) => message.role === "user" && text(message.content).includes("<command>"),
      )
      const command = text(messages[commandIndex]?.content ?? "").match(/<command>(.*?)<\/command>/s)?.[1]
      const continuation = /continue|resume/i.test(user) && !user.includes("first uploaded")
      const results = messages
        .slice(commandIndex + 1)
        .filter((message) => message.role === "tool")
        .map((message) => text(message.content))
        .join("\n")
      const seen = results.match(/\b[a-f0-9]{32}\b/)?.[0]
      const run = command && body.stream && body.tools?.length && (last === commandIndex || continuation) && !seen
      const records = messages
        .map((message) => text(message.content))
        .join("\n")
        .match(/Attachment record: ([a-f0-9]{32})/)?.[1]
      const content = run
        ? ""
        : seen && (last === commandIndex || continuation)
          ? seen
          : (records ?? "Product acceptance")
      const usage = { prompt_tokens: 20, completion_tokens: 10 }
      if (!body.stream)
        return Response.json({
          id: "fixture",
          model: "model",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage,
        })
      const frames = [
        {
          id: "fixture",
          model: "model",
          choices: [
            {
              index: 0,
              delta: run
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: crypto.randomUUID(),
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command,
                            workBrief: "Wait at product acceptance barrier",
                            yieldSeconds: 180,
                          }),
                        },
                      },
                    ],
                  }
                : { role: "assistant", content },
              finish_reason: null,
            },
          ],
        },
        {
          id: "fixture",
          model: "model",
          choices: [{ index: 0, delta: {}, finish_reason: run ? "tool_calls" : "stop" }],
          usage,
        },
      ]
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
}
