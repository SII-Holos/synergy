import { z } from "zod"
import { Bus } from "../bus"
import type { BusEvent } from "../bus/bus-event"
import { ScopeContext } from "../scope/context"

export namespace WorkspaceEvents {
  export const Fields = {
    workspaceID: z.string(),
    workspaceGeneration: z.number().int().positive(),
  }
  const Reference = z.object(Fields)

  export function identity() {
    const workspace = ScopeContext.current.workspace
    if (!workspace?.id || workspace.generation === undefined)
      throw new Error("A resolved Workspace is required for file events")
    return { workspaceID: workspace.id, workspaceGeneration: workspace.generation }
  }

  export function publish<D extends BusEvent.Definition>(
    definition: D,
    properties: Omit<z.output<D["properties"]>, keyof typeof Fields>,
  ) {
    return Bus.publish(definition, { ...properties, ...identity() } as z.output<D["properties"]>)
  }

  export function subscribe<D extends BusEvent.Definition>(
    definition: D,
    callback: (event: { type: D["type"]; properties: z.output<D["properties"]> }) => void,
  ) {
    const owner = identity()
    return Bus.subscribe(definition, (event) => {
      const reference = Reference.safeParse(event.properties)
      if (
        !reference.success ||
        reference.data.workspaceID !== owner.workspaceID ||
        reference.data.workspaceGeneration !== owner.workspaceGeneration
      )
        return
      return callback(event)
    })
  }
}
