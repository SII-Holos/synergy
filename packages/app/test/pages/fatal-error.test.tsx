import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createFatalErrorPresentationMemo } from "../../src/pages/fatal-error-state"
import type { FatalErrorSource } from "../../src/pages/error-presentation"

describe("fatal error presentation state", () => {
  test("updates diagnostics and recovery actions when the active failure changes", () => {
    createRoot((dispose) => {
      const [error, setError] = createSignal<unknown>(new Error("Renderer exploded"))
      const [source, setSource] = createSignal<FatalErrorSource>("renderer")
      const recoveries: FatalErrorSource[] = []
      let serverChanges = 0
      const presentation = createFatalErrorPresentationMemo({
        source,
        error,
        onRecover: () => () => recoveries.push(source()),
        onSecondaryAction: () => () => serverChanges++,
      })

      expect(presentation().title).toBe("renderer")
      expect(presentation().details).toContain("Renderer exploded")
      expect(presentation().primaryAction.label).toBe("reload-interface")
      expect(presentation().secondaryAction).toBeUndefined()

      setError(new Error("Server disappeared"))
      setSource("connection")

      expect(presentation().title).toBe("connection")
      expect(presentation().details).toContain("Server disappeared")
      expect(presentation().primaryAction.label).toBe("try-again")
      expect(presentation().secondaryAction?.label).toBe("change-server")

      presentation().primaryAction.run()
      presentation().secondaryAction?.run()
      expect(recoveries).toEqual(["connection"])
      expect(serverChanges).toBe(1)
      dispose()
    })
  })
})
