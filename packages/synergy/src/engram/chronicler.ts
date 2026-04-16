import { Log } from "../util/log"
import { SessionInteraction } from "../session/interaction"
import { LoopJob } from "../session/loop-job"

export namespace Chronicler {
  const log = Log.create({ service: "engram.chronicler" })

  async function run(ctx: Pick<LoopJob.Context, "sessionID" | "messages" | "abort">): Promise<void> {
    const { Config } = await import("@/config/config")
    const { Agent } = await import("@/agent/agent")
    const { Provider } = await import("@/provider/provider")
    const { MessageV2 } = await import("../session/message-v2")
    const { Session } = await import("../session")
    const { SessionInvoke } = await import("../session/invoke")
    const { Identifier } = await import("../id/id")

    const config = await Config.get()
    const evo = Config.resolveEvolution(config.identity?.evolution)
    if (!evo.active) return

    const agent = await Agent.get("chronicler")
    if (!agent) return

    const agentModel = await Agent.getAvailableModel(agent)
    if (!agentModel) {
      log.info("chronicler model not available, skipping")
      return
    }
    const model = await Provider.getModel(agentModel.providerID, agentModel.modelID)

    if (ctx.messages.length === 0) return

    const modelMessages = MessageV2.toModelMessage(ctx.messages)
    const conversationText = modelMessages
      .map((msg) => {
        const role = msg.role
        const content =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((part): part is { type: "text"; text: string } => part.type === "text")
                .map((part) => part.text)
                .join("\n")
        return `### ${role}\n${content}`
      })
      .filter((block) => block.trim().length > 0)
      .join("\n\n---\n\n")

    if (!conversationText.trim()) return

    const childSession = await Session.create({
      parentID: ctx.sessionID,
      title: "Chronicler",
      interaction: SessionInteraction.unattended("chronicler"),
    })
    const childSessionID = childSession.id

    ctx.abort.addEventListener("abort", () => SessionInvoke.cancel(childSessionID))

    await SessionInvoke.invoke({
      messageID: Identifier.ascending("message"),
      sessionID: childSessionID,
      model: { providerID: model.providerID, modelID: model.id },
      agent: "chronicler",
      parts: [
        {
          type: "text",
          text: `<conversation>\n${conversationText}\n</conversation>\n\nReview the conversation above and persist any durable knowledge worth preserving to long-term memory. Search existing memories first to avoid duplicates.`,
        },
      ],
    })
  }

  LoopJob.register({
    type: "chronicle",
    phase: "pre",
    blocking: false,
    signals: ["overflow", "compact"],
    collect() {
      return []
    },
    async execute(ctx) {
      await run(ctx)
      return "continue"
    },
  })
}
