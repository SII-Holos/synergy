import type { Tool } from "../tool/tool"

export namespace SessionInputTools {
  type Tools = Record<"read" | "list", Tool.Info>
  let tools: Tools | undefined

  export function register(value: Tools) {
    tools = value
  }

  export function get(name: keyof Tools): Tool.Info {
    const tool = tools?.[name]
    if (!tool) throw new Error(`Session input requires the ${name} tool adapter`)
    return tool
  }
}
