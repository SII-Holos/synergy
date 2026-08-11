import { describe, expect, test } from "bun:test"
import { createLocaleController } from "../../../src/context/locale/controller"
import {
  prepareLocaleSettingsSave,
  rejectLocaleSettingsSave,
} from "../../../src/components/settings/settings-locale-save"

function makeStorage(store = new Map<string, string>()) {
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  }
}

describe("settings locale save", () => {
  test("rejects the save before persistence when the target catalog cannot load", async () => {
    const controller = createLocaleController(makeStorage(new Map([["synergy-locale", "en"]])))
    controller.setActivation(async () => {
      throw new Error("catalog load failed")
    })

    expect(prepareLocaleSettingsSave({ locale: "zh-CN" }, controller)).rejects.toThrow("catalog load failed")
    expect(controller.preference()).toBe("en")
    expect(controller.pendingPreference()).toBeUndefined()
  })

  test("keeps a successful switch pending until global config confirms it", async () => {
    const controller = createLocaleController(makeStorage(new Map([["synergy-locale", "en"]])))
    controller.setActivation(async () => {})

    await prepareLocaleSettingsSave({ locale: "zh-CN" }, controller)

    expect(controller.preference()).toBe("zh-CN")
    expect(controller.pendingPreference()).toBe("zh-CN")
  })

  test("restores the authoritative locale when persistence fails", async () => {
    const controller = createLocaleController(makeStorage(new Map([["synergy-locale", "en"]])))
    controller.setActivation(async () => {})
    await prepareLocaleSettingsSave({ locale: "zh-CN" }, controller)

    expect(await rejectLocaleSettingsSave({ locale: "zh-CN" }, controller, "en")).toBe(true)
    expect(controller.preference()).toBe("en")
    expect(controller.pendingPreference()).toBeUndefined()
  })
})
