import type { startPluginPreview } from "../../packages/plugin-kit/src/testing"
import type { Message, Part } from "../../packages/sdk/js/src/client"

type Preview = Awaited<ReturnType<typeof startPluginPreview>>

export async function importPreviewConversation(
  preview: Preview,
  input: { title: string; turns?: number; tool?: string },
) {
  const { data: source } = await preview.client.session.create(
    { scopeID: "home", title: input.title },
    { throwOnError: true },
  )
  if (!source) throw new Error("Preview session was not created")
  const messages: { info: Message; parts: Part[] }[] = []
  const now = Date.now()
  for (let index = 0; index < (input.turns ?? 1); index++) {
    const root = `msg_${source.id.slice(4)}_${String(index * 2 + 1).padStart(12, "0")}`
    const assistant = `msg_${source.id.slice(4)}_${String(index * 2 + 2).padStart(12, "0")}`
    const base = { sessionID: source.id, rootID: root, visible: true, includeInContext: true }
    messages.push({
      info: {
        ...base,
        id: root,
        role: "user",
        isRoot: true,
        agent: "synergy",
        model: { providerID: "fixture", modelID: "fixture" },
        time: { created: now + index * 2 },
      },
      parts: [
        {
          id: `prt_${source.id.slice(4)}_user_${index}`,
          sessionID: source.id,
          messageID: root,
          type: "text",
          text: `Question ${index + 1}`,
        },
      ],
    })
    messages.push({
      info: {
        ...base,
        id: assistant,
        parentID: root,
        role: "assistant",
        agent: "synergy",
        mode: "synergy",
        providerID: "fixture",
        modelID: "fixture",
        time: { created: now + index * 2 + 1, completed: now + index * 2 + 2 },
        path: { cwd: "", root: "" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: `prt_${source.id.slice(4)}_answer_${index}`,
          sessionID: source.id,
          messageID: assistant,
          type: "text",
          text: `Answer ${index + 1}`,
        },
        ...(input.tool && index === 0
          ? [
              {
                id: "prt_tool",
                sessionID: source.id,
                messageID: assistant,
                type: "tool" as const,
                callID: "fixture_call",
                tool: input.tool,
                state: {
                  status: "completed" as const,
                  input: { name: "Ada" },
                  output: "Hello, Ada!",
                  title: "Greeting",
                  metadata: {},
                  time: { start: now, end: now + 1 },
                },
              },
            ]
          : []),
      ],
    })
  }
  const file = new File([JSON.stringify({ info: source, messages })], "conversation.json", { type: "application/json" })
  const { data: imported } = await preview.client.session.import({ scopeID: "home", file }, { throwOnError: true })
  if (!imported) throw new Error("Preview conversation was not imported")
  await preview.client.session.delete({ scopeID: "home", sessionID: source.id }, { throwOnError: true })
  return {
    id: imported.rootSessionID,
    url: new URL(`/aG9tZQ/session/${imported.rootSessionID}`, preview.url).href,
    messages,
  }
}
