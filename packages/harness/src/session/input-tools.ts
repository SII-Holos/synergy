import { RuntimeContext } from "../lifecycle/context"
import type { Tool } from "../tool/tool"

export namespace SessionInputTools {
  type Tools = Record<"read" | "list", Tool.Info>
  const runtimeState = RuntimeContext.state(() => ({
    tools: undefined as Tools | undefined,
  }))

  export function register(value: Tools) {
    const instanceState = runtimeState()

    instanceState.tools = value
  }

  export function get(name: keyof Tools): Tool.Info {
    const instanceState = runtimeState()

    const tool = instanceState.tools?.[name]
    if (!tool) throw new Error(`Session input requires the ${name} tool adapter`)
    return tool
  }
}
