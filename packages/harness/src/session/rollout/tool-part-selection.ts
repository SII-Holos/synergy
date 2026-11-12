import type { RolloutSchema } from "./schema"

export namespace RolloutToolPartSelection {
  export interface Selection {
    toolID: string
    started: number
    inputHash: string | null
    ambiguous: boolean
  }

  export function select(
    current: Readonly<Selection> | undefined,
    value: Pick<RolloutSchema.ToolExecutionRecord, "id" | "started" | "input">,
  ): Selection {
    if (current && current.started > value.started) return { ...current }
    const equal = current?.started === value.started
    const ambiguous = !!(
      equal &&
      (current.ambiguous ||
        (current.toolID !== value.id &&
          (current.inputHash === null || value.input.sha256 === null || current.inputHash !== value.input.sha256)))
    )
    const selected = equal && current.toolID > value.id ? current.toolID : value.id
    return {
      toolID: selected,
      started: value.started,
      inputHash: selected === value.id ? value.input.sha256 : (current?.inputHash ?? null),
      ambiguous,
    }
  }
}
