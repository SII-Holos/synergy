import { describe, expect, test } from "bun:test"
import { createLocaleController } from "./controller"

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

describe("createLocaleController", () => {
  describe("initial state", () => {
    test("ready is false initially", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.ready()).toBe(false)
    })

    test("epoch locale en when no mirror and navigatorLanguages absent", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.epoch().locale).toBe("en")
      expect(ctrl.epoch().generation).toBe(0)
    })

    test("preference returns system when no mirror", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.preference()).toBe("system")
    })

    test("activeLocale returns en when system and no zh languages", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.activeLocale()).toBe("en")
    })

    test("source returns bootstrap-mirror initially", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.source()).toBe("bootstrap-mirror")
    })

    test("pendingPreference is undefined initially", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.pendingPreference()).toBeUndefined()
    })

    test("error is undefined initially", () => {
      const ctrl = createLocaleController(makeStorage())
      expect(ctrl.error()).toBeUndefined()
    })
  })

  describe("mirror localStorage", () => {
    test("persists literal 'system' for system preference", async () => {
      const store = new Map<string, string>()
      const storage = makeStorage(store)
      const ctrl = createLocaleController(storage)
      ctrl.setActivation(succeedActivation())
      await ctrl.setPreference("system")
      expect(ctrl.preference()).toBe("system")
      expect(store.get("synergy-locale")).toBe("system")
    })

    test("persists literal 'en' for en preference", async () => {
      const store = new Map<string, string>()
      const ctrl = createLocaleController(makeStorage(store))
      ctrl.setActivation(succeedActivation())
      await ctrl.setPreference("en")
      expect(store.get("synergy-locale")).toBe("en")
    })

    test("reads mirror preference from localStorage", () => {
      const store = new Map([["synergy-locale", "zh-CN"]])
      const ctrl = createLocaleController(makeStorage(store))
      expect(ctrl.preference()).toBe("zh-CN")
    })

    test("reads 'system' mirror as system preference", () => {
      const store = new Map([["synergy-locale", "system"]])
      const ctrl = createLocaleController(makeStorage(store))
      expect(ctrl.preference()).toBe("system")
    })

    test("invalid mirror value normalizes to system", () => {
      const store = new Map([["synergy-locale", "fr"]])
      const ctrl = createLocaleController(makeStorage(store))
      expect(ctrl.preference()).toBe("system")
    })
  })

  describe("storage failures", () => {
    test("falls back to system when reading the mirror throws", () => {
      const ctrl = createLocaleController({
        getItem() {
          throw new DOMException("blocked", "SecurityError")
        },
        setItem() {},
        removeItem() {},
      })

      expect(ctrl.preference()).toBe("system")
      expect(ctrl.activeLocale()).toBe("en")
    })

    test("commits controller state when writing the mirror throws", async () => {
      const ctrl = createLocaleController({
        getItem: () => "en",
        setItem() {
          throw new DOMException("full", "QuotaExceededError")
        },
        removeItem() {},
      })
      ctrl.setActivation(succeedActivation())

      const result = await ctrl.setPreference("zh-CN")

      expect(result.status).toBe("applied")
      expect(ctrl.preference()).toBe("zh-CN")
      expect(ctrl.activeLocale()).toBe("zh-CN")
    })
  })

  describe("navigatorLanguages", () => {
    test("zh-Hans maps to zh-CN activeLocale", () => {
      const ctrl = createLocaleController(makeStorage(), ["zh-Hans"])
      expect(ctrl.activeLocale()).toBe("zh-CN")
    })

    test("honors the first supported language in preference order", () => {
      const ctrl = createLocaleController(makeStorage(), ["en-US", "zh-TW"])
      expect(ctrl.activeLocale()).toBe("en")
    })

    test("skips unsupported languages before the first supported language", () => {
      const ctrl = createLocaleController(makeStorage(), ["de-DE", "zh-TW", "en-US"])
      expect(ctrl.activeLocale()).toBe("zh-CN")
    })

    test("non-zh languages map to en", () => {
      const ctrl = createLocaleController(makeStorage(), ["de-DE", "fr-FR"])
      expect(ctrl.activeLocale()).toBe("en")
    })
  })

  test("refreshes the active catalog when system languages change", async () => {
    const ctrl = createLocaleController(makeStorage(), ["en-US"])
    ctrl.setActivation(succeedActivation())
    await ctrl.bootstrap()

    await ctrl.refreshSystemLanguages(["zh-CN", "en-US"])

    expect(ctrl.preference()).toBe("system")
    expect(ctrl.activeLocale()).toBe("zh-CN")
  })

  test("records system language changes without overriding an explicit preference", async () => {
    const ctrl = createLocaleController(makeStorage(), ["en-US"])
    ctrl.setActivation(succeedActivation())
    await ctrl.setPreference("en")

    await ctrl.refreshSystemLanguages(["zh-CN"])

    expect(ctrl.preference()).toBe("en")
    expect(ctrl.activeLocale()).toBe("en")
  })

  describe("source tracking", () => {
    test("transitions to user after setPreference", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.setPreference("zh-CN")
      expect(ctrl.source()).toBe("user")
    })

    test("transitions to global-config after reconcileGlobalPreference", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.reconcileGlobalPreference("en")
      expect(ctrl.source()).toBe("global-config")
    })
  })

  describe("setPreference async activation", () => {
    test("returns an applied result when activation succeeds", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      const result = await ctrl.setPreference("zh-CN")
      expect(result.status).toBe("applied")
      expect(ctrl.preference()).toBe("zh-CN")
      expect(ctrl.activeLocale()).toBe("zh-CN")
      expect(ctrl.pendingPreference()).toBe("zh-CN")
    })

    test("returns false and leaves state unchanged on activation failure", async () => {
      const store = new Map([["synergy-locale", "en"]])
      const ctrl = createLocaleController(makeStorage(store))
      ctrl.setActivation(async (_locale) => {
        throw new Error("catalog load failed")
      })
      const result = await ctrl.setPreference("zh-CN")
      expect(result.status).toBe("failed")
      expect(ctrl.preference()).toBe("en")
      expect(ctrl.activeLocale()).toBe("en")
      expect(ctrl.pendingPreference()).toBeUndefined()
    })

    test("rejects invalid runtime preference values without activation or persistence", async () => {
      const store = new Map<string, string>()
      const ctrl = createLocaleController(makeStorage(store))
      let activations = 0
      ctrl.setActivation(async () => {
        activations += 1
      })

      const result = await ctrl.setPreference("fr" as Parameters<typeof ctrl.setPreference>[0])

      expect(result.status).toBe("failed")
      expect(activations).toBe(0)
      expect(ctrl.preference()).toBe("system")
      expect(store.has("synergy-locale")).toBe(false)
    })

    test("rapid en→zh→en only last generation commits", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(async (_locale) => {})
      const p1 = ctrl.setPreference("zh-CN")
      const p2 = ctrl.setPreference("en")
      await Promise.all([p1, p2])
      expect(ctrl.preference()).toBe("en")
      expect(ctrl.activeLocale()).toBe("en")
    })

    test("reports an older rapid switch as superseded instead of failed", async () => {
      const ctrl = createLocaleController(makeStorage())
      let releaseZh!: () => void
      const zhReady = new Promise<void>((resolve) => {
        releaseZh = resolve
      })
      ctrl.setActivation(async (locale) => {
        if (locale === "zh-CN") await zhReady
      })

      const stale = ctrl.setPreference("zh-CN")
      const current = await ctrl.setPreference("en")
      releaseZh()

      expect(current.status).toBe("applied")
      expect((await stale).status).toBe("superseded")
    })
  })

  test("stale catalog preparation cannot commit after a newer switch", async () => {
    const ctrl = createLocaleController(makeStorage())
    const commits: string[] = []
    let releaseZh!: () => void
    const zhReady = new Promise<void>((resolve) => {
      releaseZh = resolve
    })
    ctrl.setActivation(async (locale) => {
      if (locale === "zh-CN") await zhReady
      return () => commits.push(locale)
    })

    const stale = ctrl.setPreference("zh-CN")
    const current = ctrl.setPreference("en")
    await current
    releaseZh()
    await stale

    expect(commits).toEqual(["en"])
    expect(ctrl.activeLocale()).toBe("en")
  })

  describe("reconcileGlobalPreference", () => {
    test("applies when no pending preference", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.reconcileGlobalPreference("en")
      expect(ctrl.preference()).toBe("en")
      expect(ctrl.source()).toBe("global-config")
    })

    test("acknowledges when pending matches config value", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      const prefPromise = ctrl.setPreference("en")
      await ctrl.reconcileGlobalPreference("en")
      await prefPromise
      expect(ctrl.preference()).toBe("en")
      expect(ctrl.source()).toBe("global-config")
    })

    test("does not overwrite when pending differs from config", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(async (_locale) => {
        await new Promise((r) => setTimeout(r, 50))
      })
      const prefPromise = ctrl.setPreference("en")
      expect(ctrl.pendingPreference()).toBe("en")
      await ctrl.reconcileGlobalPreference("zh-CN")
      await prefPromise
      expect(ctrl.preference()).toBe("en")
    })

    test("rejects a failed pending save and restores the authoritative preference", async () => {
      const ctrl = createLocaleController(makeStorage(), ["en-US"])
      ctrl.setActivation(succeedActivation())
      await ctrl.reconcileGlobalPreference("en")
      await ctrl.setPreference("zh-CN")

      await ctrl.rejectPendingPreference("zh-CN", "en")

      expect(ctrl.pendingPreference()).toBeUndefined()
      expect(ctrl.preference()).toBe("en")
      expect(ctrl.activeLocale()).toBe("en")
      expect(ctrl.source()).toBe("global-config")
    })

    test("does not let an older failed save reject a newer pending preference", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.setPreference("zh-CN")
      await ctrl.setPreference("en")

      await ctrl.rejectPendingPreference("zh-CN", "system")

      expect(ctrl.pendingPreference()).toBe("en")
      expect(ctrl.preference()).toBe("en")
    })

    test("ignores invalid runtime global preference values", async () => {
      const store = new Map<string, string>()
      const ctrl = createLocaleController(makeStorage(store))
      let activations = 0
      ctrl.setActivation(async () => {
        activations += 1
      })

      await ctrl.reconcileGlobalPreference("fr" as Parameters<typeof ctrl.reconcileGlobalPreference>[0])

      expect(activations).toBe(0)
      expect(ctrl.preference()).toBe("system")
      expect(store.has("synergy-locale")).toBe(false)
    })

    test("undefined clears global-config back to system", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.reconcileGlobalPreference("en")
      expect(ctrl.source()).toBe("global-config")
      await ctrl.reconcileGlobalPreference(undefined)
      expect(ctrl.preference()).toBe("system")
      expect(ctrl.source()).not.toBe("global-config")
    })

    test("removing a global override activates the resolved system catalog", async () => {
      const ctrl = createLocaleController(makeStorage(), ["zh-CN"])
      const commits: string[] = []
      ctrl.setActivation(async (locale) => () => {
        commits.push(locale)
      })

      await ctrl.reconcileGlobalPreference("en")
      await ctrl.reconcileGlobalPreference(undefined)

      expect(commits).toEqual(["en", "zh-CN"])
      expect(ctrl.preference()).toBe("system")
      expect(ctrl.activeLocale()).toBe("zh-CN")
      expect(ctrl.source()).toBe("system")
    })
  })

  describe("ready", () => {
    test("becomes true after bootstrap activation succeeds", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      await ctrl.setPreference("en")
      expect(ctrl.ready()).toBe(true)
    })
  })

  describe("epoch", () => {
    test("generation increments on successful switch", async () => {
      const ctrl = createLocaleController(makeStorage())
      ctrl.setActivation(succeedActivation())
      const g0 = ctrl.generation()
      await ctrl.setPreference("zh-CN")
      expect(ctrl.generation()).toBeGreaterThan(g0)
    })

    test("generation does not increment on failed switch", async () => {
      const store = new Map([["synergy-locale", "en"]])
      const ctrl = createLocaleController(makeStorage(store))
      ctrl.setActivation(async (_locale) => {
        throw new Error("fail")
      })
      const g0 = ctrl.generation()
      await ctrl.setPreference("zh-CN")
      expect(ctrl.generation()).toBe(g0)
    })
  })
})
