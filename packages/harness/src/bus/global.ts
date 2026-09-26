import { RuntimeContext } from "../lifecycle/context"
import { EventEmitter } from "events"

export const GlobalBus = RuntimeContext.state(
  () =>
    new EventEmitter<{
      event: [
        {
          scopeID: string | null
          payload: any
        },
      ]
    }>(),
)
