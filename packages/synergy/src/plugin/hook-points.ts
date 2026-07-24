export type PluginHookMode = "observer" | "transform" | "guard"
export type PluginHookFailurePolicy = "continue" | "fail"

export interface PluginHookPoint {
  name: string
  mode: PluginHookMode
  failure: PluginHookFailurePolicy
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  timeoutMs: number
  requiredCapability?: string
  redactErrors?: boolean
}

const points = new Map<string, PluginHookPoint>()

function define(name: string, mode: PluginHookMode, failure: PluginHookFailurePolicy = "continue") {
  points.set(name, {
    name,
    mode,
    failure,
    inputSchema: {},
    outputSchema: {},
    timeoutMs: 120_000,
  })
}

function defineCapabilityObserver(name: string, requiredCapability: string) {
  define(name, "observer")
  points.get(name)!.requiredCapability = requiredCapability
}

for (const name of [
  "session.turn.after",
  "cortex.task.after",
  "blueprint.after",
  "lightloop.after",
  "agenda.run.after",
  "agenda.run.error",
  "note.create.after",
  "note.update.after",
  "library.experience.encode.after",
  "config.changed",
]) {
  define(name, "observer")
}

defineCapabilityObserver("session.user-message.after", "session.read")
points.get("session.user-message.after")!.redactErrors = true

for (const name of [
  "chat.message",
  "chat.params",
  "tool.execute.before",
  "tool.execute.after",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.text.complete",
  "agenda.run.before",
  "note.create.before",
  "note.update.before",
  "note.search.before",
  "note.search.after",
  "library.memory.search.before",
  "library.memory.search.after",
]) {
  define(name, "transform")
}

define("permission.ask", "guard", "continue")

export namespace PluginHookPointRegistry {
  export function get(name: string): PluginHookPoint {
    const point = points.get(name)
    if (!point) throw new Error(`Unknown plugin hook point: ${name}`)
    return point
  }

  export function list(): PluginHookPoint[] {
    return [...points.values()]
  }
}
