import type { RuntimeComponentInfo } from "./gen/types.gen.js"

export const RUNTIME_READY_PREFIX = "SYNERGY_READY_V1 "
export const RUNTIME_READY_MAX_LENGTH = 64 * 1024

export interface RuntimeReady {
  protocol: 1
  pid: number
  version: string
  home: string
  url: string
  components: RuntimeComponentInfo[]
}

export function runtimeReadyLine(value: RuntimeReady): string {
  const line = RUNTIME_READY_PREFIX + JSON.stringify(value)
  if (line.length > RUNTIME_READY_MAX_LENGTH) throw new Error("Runtime readiness record is too large")
  return line + "\n"
}

export function parseRuntimeReady(line: string): RuntimeReady | undefined {
  if (!line.startsWith(RUNTIME_READY_PREFIX)) return
  if (line.length > RUNTIME_READY_MAX_LENGTH) throw new Error("Runtime readiness record is too large")
  const data: unknown = JSON.parse(line.slice(RUNTIME_READY_PREFIX.length))
  if (!data || typeof data !== "object") throw new Error("Invalid runtime readiness record")
  const value = data as Partial<RuntimeReady>
  if (
    value.protocol !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid ?? 0) <= 0 ||
    typeof value.version !== "string" ||
    typeof value.home !== "string" ||
    typeof value.url !== "string" ||
    !Array.isArray(value.components) ||
    value.components.some(
      (component) =>
        !component ||
        typeof component.id !== "string" ||
        typeof component.version !== "string" ||
        component.apiVersion !== 1,
    ) ||
    new Set(value.components.map((component) => component.id)).size !== value.components.length
  )
    throw new Error("Invalid runtime readiness record")
  return value as RuntimeReady
}
