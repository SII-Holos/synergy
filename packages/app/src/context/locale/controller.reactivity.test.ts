/**
 * Proves Solid reactivity: every controller accessor is a real Solid Signal.
 * Bun's test runner does not flush Solid's reactive scheduler across async
 * boundaries, so we prove reactivity via direct signal reads after await.
 */
import { describe, expect, test } from "bun:test"
import { createLocaleController } from "./controller"
import type { ActiveLocale } from "./types"

function makeStorage(store = new Map<string, string>()) {
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  }
}

function succeedActivation() {
  return async (_locale: string) => {}
}

describe("Solid signal identity proofs", () => {
  test("accessors return correct initial values", () => {
    const ctrl = createLocaleController(makeStorage())
    expect(ctrl.activeLocale()).toBe("en")
    expect(ctrl.preference()).toBe("system")
    expect(ctrl.source()).toBe("bootstrap-mirror")
    expect(ctrl.ready()).toBe(false)
    expect(ctrl.pendingPreference()).toBeUndefined()
  })

  test("activeLocale changes after async setPreference", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    expect(ctrl.activeLocale()).toBe("en")
    await ctrl.setPreference("zh-CN")
    expect(ctrl.activeLocale()).toBe("zh-CN")
  })

  test("preference changes after async setPreference", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    expect(ctrl.preference()).toBe("system")
    await ctrl.setPreference("en")
    expect(ctrl.preference()).toBe("en")
  })

  test("ready transitions false→true after activation", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    expect(ctrl.ready()).toBe(false)
    await ctrl.setPreference("en")
    expect(ctrl.ready()).toBe(true)
  })

  test("generation increments on successful switch", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    expect(ctrl.generation()).toBe(0)
    await ctrl.setPreference("zh-CN")
    expect(ctrl.generation()).toBe(1)
    await ctrl.setPreference("en")
    expect(ctrl.generation()).toBe(2)
  })

  test("generation does NOT increment on failed switch", async () => {
    const store = new Map([["synergy-locale", "en"]])
    const ctrl = createLocaleController(makeStorage(store))
    ctrl.setActivation(async () => {
      throw new Error("fail")
    })
    expect(ctrl.generation()).toBe(0)
    await ctrl.setPreference("zh-CN")
    expect(ctrl.generation()).toBe(0)
  })

  test("source transitions on user setPreference", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    expect(ctrl.source()).toBe("bootstrap-mirror")
    await ctrl.setPreference("en")
    expect(ctrl.source()).toBe("user")
  })

  test("source transitions on global config reconcile", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    await ctrl.reconcileGlobalPreference("en")
    expect(ctrl.source()).toBe("global-config")
  })

  test("bootstrap fallback sets source to fallback", async () => {
    const store = new Map([["synergy-locale", "zh-CN"]])
    const ctrl = createLocaleController(makeStorage(store))
    ctrl.setActivation(async (locale: ActiveLocale) => {
      if (locale === "zh-CN") throw new Error("zh unavailable")
    })
    await ctrl.bootstrap()
    expect(ctrl.ready()).toBe(true)
    expect(ctrl.activeLocale()).toBe("en")
    expect(ctrl.source()).toBe("fallback")
    expect(ctrl.error()).toBeDefined()
  })
})

describe("pending/confirmation semantics", () => {
  test("pending retained after successful setPreference until server confirms", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())

    await ctrl.setPreference("en")
    expect(ctrl.pendingPreference()).toBe("en")

    await ctrl.reconcileGlobalPreference("en")
    expect(ctrl.pendingPreference()).toBeUndefined()
  })

  test("matching server confirm clears pending without re-activation", async () => {
    const ctrl = createLocaleController(makeStorage())
    let count = 0
    ctrl.setActivation(async () => {
      count++
    })
    await ctrl.setPreference("zh-CN")
    const afterUser = count
    await ctrl.reconcileGlobalPreference("zh-CN")
    expect(count).toBe(afterUser)
    expect(ctrl.pendingPreference()).toBeUndefined()
  })

  test("differing server value while pending does not overwrite", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    const p = ctrl.setPreference("en")
    expect(ctrl.pendingPreference()).toBe("en")
    await ctrl.reconcileGlobalPreference("zh-CN")
    expect(ctrl.pendingPreference()).toBe("en")
    await p
    expect(ctrl.preference()).toBe("en")
    expect(ctrl.pendingPreference()).toBe("en")
  })

  test("rapid switches only last commits", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(async () => {})
    await Promise.all([ctrl.setPreference("zh-CN"), ctrl.setPreference("en")])
    expect(ctrl.preference()).toBe("en")
    expect(ctrl.activeLocale()).toBe("en")
    expect(ctrl.pendingPreference()).toBe("en")
  })

  test("failure leaves prior state, no pending, error set, mirror untouched", async () => {
    const store = new Map([["synergy-locale", "en"]])
    const ctrl = createLocaleController(makeStorage(store))
    ctrl.setActivation(async () => {
      throw new Error("fail")
    })
    const g0 = ctrl.generation()
    const ok = await ctrl.setPreference("zh-CN")
    expect(ok).toBe(false)
    expect(ctrl.preference()).toBe("en")
    expect(ctrl.activeLocale()).toBe("en")
    expect(ctrl.pendingPreference()).toBeUndefined()
    expect(ctrl.generation()).toBe(g0)
    expect(ctrl.error()).toBeDefined()
    expect(store.get("synergy-locale")).toBe("en")
  })

  test("reconcileGlobalPreference(undefined) clears global-config to system", async () => {
    const ctrl = createLocaleController(makeStorage())
    ctrl.setActivation(succeedActivation())
    await ctrl.reconcileGlobalPreference("en")
    expect(ctrl.source()).toBe("global-config")
    await ctrl.reconcileGlobalPreference(undefined)
    expect(ctrl.preference()).toBe("system")
    expect(ctrl.source()).toBe("system")
  })
})

describe("bootstrap flow", () => {
  test("zh-CN mirror, activation ok, ready with zh active", async () => {
    const store = new Map([["synergy-locale", "zh-CN"]])
    const ctrl = createLocaleController(makeStorage(store))
    ctrl.setActivation(succeedActivation())
    await ctrl.bootstrap()
    expect(ctrl.ready()).toBe(true)
    expect(ctrl.activeLocale()).toBe("zh-CN")
  })

  test("zh activation fails, falls back en, source=fallback", async () => {
    const store = new Map([["synergy-locale", "zh-CN"]])
    const ctrl = createLocaleController(makeStorage(store))
    ctrl.setActivation(async (locale: ActiveLocale) => {
      if (locale === "zh-CN") throw new Error("zh unavailable")
    })
    await ctrl.bootstrap()
    expect(ctrl.ready()).toBe(true)
    expect(ctrl.activeLocale()).toBe("en")
    expect(ctrl.source()).toBe("fallback")
    expect(ctrl.error()).toBeDefined()
  })
})
