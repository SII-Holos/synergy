import { describe, expect, test } from "bun:test"
import { applyLocalePreference } from "./locale-preference-change"

describe("locale preference change", () => {
  test("updates Settings only after the target catalog activates", async () => {
    const events: string[] = []

    const changed = await applyLocalePreference({
      preference: "zh-CN",
      controller: {
        async setPreference(preference) {
          events.push(`activate:${preference}`)
          return { status: "applied" as const }
        },
      },
      onChange(preference) {
        events.push(`settings:${preference}`)
      },
    })

    expect(changed.status).toBe("applied")
    expect(events).toEqual(["activate:zh-CN", "settings:zh-CN"])
  })

  test("leaves Settings unchanged when catalog activation fails", async () => {
    const changes: string[] = []

    const changed = await applyLocalePreference({
      preference: "zh-CN",
      controller: { setPreference: async () => ({ status: "failed" as const, error: new Error("catalog") }) },
      onChange(preference) {
        changes.push(preference)
      },
    })

    expect(changed.status).toBe("failed")
    expect(changes).toEqual([])
  })

  test("does not update Settings or report failure when an older switch is superseded", async () => {
    const changes: string[] = []

    const result = await applyLocalePreference({
      preference: "zh-CN",
      controller: { setPreference: async () => ({ status: "superseded" as const }) },
      onChange(preference) {
        changes.push(preference)
      },
    })

    expect(result.status).toBe("superseded")
    expect(changes).toEqual([])
  })
})
