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
          return true
        },
      },
      onChange(preference) {
        events.push(`settings:${preference}`)
      },
    })

    expect(changed).toBe(true)
    expect(events).toEqual(["activate:zh-CN", "settings:zh-CN"])
  })

  test("leaves Settings unchanged when catalog activation fails", async () => {
    const changes: string[] = []

    const changed = await applyLocalePreference({
      preference: "zh-CN",
      controller: { setPreference: async () => false },
      onChange(preference) {
        changes.push(preference)
      },
    })

    expect(changed).toBe(false)
    expect(changes).toEqual([])
  })
})
