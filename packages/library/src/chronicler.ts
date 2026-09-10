import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { SessionInteraction } from "@ericsanchezok/synergy-harness/session/interaction"
import { LoopJob } from "@ericsanchezok/synergy-harness/session/loop-job"

export namespace Chronicler {
  const log = Log.create({ service: "library.chronicler" })

  async function run(ctx: Pick<LoopJob.Context, "sessionID" | "abort">): Promise<void> {
    const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
    const { Agent } = await import("@ericsanchezok/synergy-harness/agent/agent")
    const { Provider } = await import("@ericsanchezok/synergy-harness/provider/provider")
    const { MessageV2 } = await import("@ericsanchezok/synergy-harness/session/message-v2")
    const { Session } = await import("@ericsanchezok/synergy-harness/session")
    const { SessionHistory } = await import("@ericsanchezok/synergy-harness/session/history")
    const { SessionInvoke } = await import("@ericsanchezok/synergy-harness/session/invoke")
    const { Identifier } = await import("@ericsanchezok/synergy-harness/id/id")

    const config = await Config.current()
    const library = config.library
    // memory.enabled defaults to true; only an explicit false disables the chronicler
    if (library?.memory?.enabled === false) return

    const agent = await Agent.get("chronicler")
    if (!agent) return

    const agentModel = await Agent.getAvailableModel(agent)
    if (!agentModel) {
      log.info("chronicler model not available, skipping")
      return
    }
    const model = await Provider.getModel(agentModel.providerID, agentModel.modelID)

    const messages = await SessionHistory.detachedModelMessages({ sessionID: ctx.sessionID, signal: ctx.abort })
    if (messages.length === 0) return

    const modelMessages = MessageV2.toModelMessage(messages)
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
      completionNotice: { silent: true },
    })
    const childSessionID = childSession.id

    const cancel = () => SessionInvoke.cancel(childSessionID)
    ctx.abort.addEventListener("abort", cancel, { once: true })
    try {
      ctx.abort.throwIfAborted()
      await SessionInvoke.invokeInternal({
        messageID: Identifier.ascending("message"),
        sessionID: childSessionID,
        model: { providerID: model.providerID, modelID: model.id },
        agent: "chronicler",
        origin: { type: "system" },
        parts: [
          {
            type: "text",
            text: `<conversation>\n${conversationText}\n</conversation>\n\nReview the conversation above and persist any durable knowledge worth preserving to long-term memory. Search existing memories first to avoid duplicates.`,
          },
        ],
      })
    } finally {
      ctx.abort.removeEventListener("abort", cancel)
    }
  }

  export function register() {
    LoopJob.register({
      type: "chronicle",
      phase: "pre",
      blocking: false,
      detached: true,
      signals: ["compact"],
      collect() {
        return []
      },
      capture(ctx) {
        return { type: "chronicle", sessionID: ctx.sessionID }
      },
      key(input) {
        return input.sessionID
      },
      timeoutMs: 180_000,
      async execute(input, signal) {
        await run({ sessionID: input.sessionID, abort: signal })
        return "pass"
      },
    })
  }
}
