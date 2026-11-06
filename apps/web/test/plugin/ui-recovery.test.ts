import { expect, test } from "bun:test"
import { resolveSafeUI } from "../../src/plugin/ui-recovery"

test("safe UI survives router redirects and reloads until explicitly restarted", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  expect(resolveSafeUI("", storage)).toBe(false)
  expect(resolveSafeUI("?safe-ui=1", storage)).toBe(true)
  expect(resolveSafeUI("", storage)).toBe(true)
  expect(resolveSafeUI("?safe-ui=0", storage)).toBe(false)
  expect(resolveSafeUI("", storage)).toBe(false)
})
