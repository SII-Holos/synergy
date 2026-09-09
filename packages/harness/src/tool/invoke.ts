import { z } from "zod"
import type { Tool } from "./tool"

export namespace ToolInvocation {
  export interface Input {
    sessionID: string
    messageID: string
    agent: string
    tool: string
    args: unknown
    callID?: string
    parentCallID?: string
    signal: AbortSignal
  }

  export async function invoke(input: Input): Promise<Tool.ExecutionResult> {
    input.signal.throwIfAborted()
    const args = z.record(z.string(), z.unknown()).parse(input.args)
    const [
      { ScopeContext },
      { Session },
      { MessageV2 },
      { Agent },
      { Provider },
      { SessionProcessor },
      { ToolResolver },
      { Identifier },
    ] = await Promise.all([
      import("../scope/context"),
      import("../session"),
      import("../session/message-v2"),
      import("../agent/agent"),
      import("../provider/provider"),
      import("../session/processor"),
      import("../session/tool-resolver"),
      import("../id/id"),
    ])
    const session = await Session.get(input.sessionID)
    if (session.scope.id !== ScopeContext.current.scope.id)
      throw new Error("Tool invocation Scope does not own the session")
    const message = await MessageV2.get({
      scopeID: session.scope.id,
      sessionID: session.id,
      messageID: input.messageID,
    })
    if (message.info.role !== "assistant") throw new Error("Tool invocation requires an assistant message")
    const agent = await Agent.get(input.agent)
    if (!agent) throw new Error(`Unknown agent: ${input.agent}`)
    const model = await Provider.getModel(message.info.providerID, message.info.modelID)
    const processor = SessionProcessor.create({
      assistantMessage: message.info,
      sessionID: session.id,
      model,
      abort: input.signal,
    })
    try {
      const resolved = await ToolResolver.resolveWithAvailability({
        agent,
        model,
        session,
        sessionID: session.id,
        processor,
        includeMCP: true,
        userTools: { [input.tool]: true },
      })
      const tool = resolved.executionTools[input.tool]
      if (!tool?.execute) throw new Error(`Tool "${input.tool}" is not available to this context`)
      const result = await processor.executeToolCall({
        callID: input.callID ?? Identifier.ascending("part"),
        toolName: input.tool,
        args,
        tool,
        executor: resolved.executorKinds[input.tool],
        parentCallID: input.parentCallID,
      })
      return {
        title: result.title,
        output: result.output,
        metadata: result.metadata,
        ...(result.attachments ? { attachments: result.attachments } : {}),
      }
    } finally {
      processor.dispose("host tool invocation")
    }
  }
}
