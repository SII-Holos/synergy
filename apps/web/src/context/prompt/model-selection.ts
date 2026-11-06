import type { SessionThinkingSelection } from "@ericsanchezok/synergy-sdk"

export function thinkingChoices(variants: string[]) {
  return ["", ...(variants.includes("off") ? ["off"] : []), ...variants.filter((variant) => variant !== "off")]
}

export function thinkingValue(thinking: SessionThinkingSelection) {
  return thinking.mode === "variant" ? thinking.variant : thinking.mode === "off" ? "off" : undefined
}

export function thinkingSelection(value?: string): SessionThinkingSelection {
  return value === "off" ? { mode: "off" } : value ? { mode: "variant", variant: value } : { mode: "provider-default" }
}

export function createModelSelectionWriter() {
  const queues = new Map<string, Promise<unknown>>()
  return {
    enqueue<T>(key: string, write: () => Promise<T>): Promise<T> {
      const previous = queues.get(key) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(write)
      queues.set(key, next)
      const cleanup = () => {
        if (queues.get(key) === next) queues.delete(key)
      }
      void next.then(cleanup, cleanup)
      return next
    },
  }
}
