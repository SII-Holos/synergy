import { ProcessRegistry } from "@/process/registry"
import type { ExternalAgent } from "./bridge"

export namespace ExternalAgentProcessTracker {
  export function attach(input: {
    adapter: string
    pid?: number
    cwd: string
    context: ExternalAgent.TurnContext
    platform?: NodeJS.Platform
  }) {
    if ((input.platform ?? process.platform) !== "linux") {
      return { processId: undefined, dispose() {} }
    }
    const tracked = ProcessRegistry.create({
      command: input.adapter,
      description: `${input.adapter} external agent turn`,
      cwd: input.cwd,
      owner: {
        sessionID: input.context.sessionID,
        messageID: input.context.messageID,
        tool: `external-agent:${input.adapter}`,
      },
    })
    tracked.pid = input.pid
    return {
      processId: tracked.id,
      dispose() {
        ProcessRegistry.remove(tracked.id)
      },
    }
  }
}
