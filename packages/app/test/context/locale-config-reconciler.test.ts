import { describe, expect, test } from "bun:test"
import { createLocaleController } from "../../src/context/locale/controller"
import { createLocaleConfigReconciliation } from "../../src/context/locale-config-reconciliation"

function memoryStorage(initial?: string): Storage {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set("synergy-locale", initial)
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, value)
    },
  }
}

function controller(languages: readonly string[] = ["en-US"], mirror?: string) {
  const value = createLocaleController(memoryStorage(mirror), languages)
  value.setActivation(async () => {})
  return value
}

describe("locale config reconciliation", () => {
  test("treats an absent global value as system and deduplicates unchanged snapshots", async () => {
    const calls: Array<string | undefined> = []
    const reconciliation = createLocaleConfigReconciliation({
      reconcileGlobalPreference: async (preference) => {
        calls.push(preference)
      },
    })

    await reconciliation.sync(undefined)
    expect(await reconciliation.sync(undefined)).toBeUndefined()
    expect(calls).toEqual([undefined])
  })

  test("an absent global value overrides a stale bootstrap mirror with system locale", async () => {
    const value = controller(["en-US"], "zh-CN")
    expect(value.preference()).toBe("zh-CN")

    const reconciliation = createLocaleConfigReconciliation(value)
    await reconciliation.sync(undefined)

    expect(value.preference()).toBe("system")
    expect(value.activeLocale()).toBe("en")
    expect(value.source()).toBe("system")
  })

  test("applies successive global English and Simplified Chinese preferences", async () => {
    const value = controller()
    const reconciliation = createLocaleConfigReconciliation(value)

    await reconciliation.sync("en")
    expect(value.preference()).toBe("en")
    expect(value.activeLocale()).toBe("en")

    await reconciliation.sync("zh-CN")
    expect(value.preference()).toBe("zh-CN")
    expect(value.activeLocale()).toBe("zh-CN")
  })

  test("matching global confirmation clears the pending user preference", async () => {
    const value = controller()
    await value.setPreference("zh-CN")
    expect(value.pendingPreference()).toBe("zh-CN")

    const reconciliation = createLocaleConfigReconciliation(value)
    await reconciliation.sync("zh-CN")

    expect(value.pendingPreference()).toBeUndefined()
    expect(value.preference()).toBe("zh-CN")
  })

  test("conflicting global state does not overwrite a pending user preference", async () => {
    const value = controller()
    await value.setPreference("zh-CN")

    const reconciliation = createLocaleConfigReconciliation(value)
    await reconciliation.sync("en")

    expect(value.pendingPreference()).toBe("zh-CN")
    expect(value.preference()).toBe("zh-CN")
    expect(value.activeLocale()).toBe("zh-CN")
  })
})
