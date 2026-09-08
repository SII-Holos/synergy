import { afterEach, describe, expect, test } from "bun:test"
import {
  createSettingsMobileNavigationState,
  reduceSettingsMobileNavigation,
  restoreSettingsMobileListFocus,
} from "../../../src/components/settings/settings-mobile-navigation"

const sections = ["general", "models", "providers"]

afterEach(() => {
  document.body.innerHTML = ""
})

describe("mobile Settings navigation", () => {
  test("opens the list for General and valid details for explicit deep links", () => {
    expect(createSettingsMobileNavigationState("general", sections, false)).toEqual({
      activeTab: "general",
      detailOpen: false,
      desktop: false,
    })
    expect(createSettingsMobileNavigationState("models", sections, false)).toEqual({
      activeTab: "models",
      detailOpen: true,
      desktop: false,
    })
  })

  test("normalizes an invalid initial tab before mobile detail can render", () => {
    expect(createSettingsMobileNavigationState("missing", sections, false)).toEqual({
      activeTab: "general",
      detailOpen: false,
      desktop: false,
    })
  })

  test("opens a selected section and returns to the list without losing selection", () => {
    const initial = createSettingsMobileNavigationState("general", sections, false)
    const detail = reduceSettingsMobileNavigation(initial, { type: "select", id: "providers" })
    expect(detail).toEqual({ activeTab: "providers", detailOpen: true, desktop: false })
    expect(reduceSettingsMobileNavigation(detail, { type: "back" })).toEqual({
      activeTab: "providers",
      detailOpen: false,
      desktop: false,
    })
  })

  test("returns to the list when crossing from desktop into mobile", () => {
    const mobileDetail = createSettingsMobileNavigationState("models", sections, false)
    const desktop = reduceSettingsMobileNavigation(mobileDetail, { type: "layout", desktop: true })
    expect(desktop).toEqual({ activeTab: "models", detailOpen: true, desktop: true })
    expect(reduceSettingsMobileNavigation(desktop, { type: "layout", desktop: false })).toEqual({
      activeTab: "models",
      detailOpen: false,
      desktop: false,
    })
  })

  test("falls back to the list if the active section disappears", () => {
    const detail = createSettingsMobileNavigationState("models", sections, false)
    expect(reduceSettingsMobileNavigation(detail, { type: "validate", sectionIDs: ["general"] })).toEqual({
      activeTab: "general",
      detailOpen: false,
      desktop: false,
    })
  })

  test("restores focus to the selected section after leaving mobile detail", () => {
    const navigation = document.createElement("div")
    const selected = document.createElement("button")
    selected.setAttribute("aria-current", "page")
    const back = document.createElement("button")
    navigation.append(selected)
    document.body.append(navigation, back)
    back.focus()

    const scheduled: Array<() => void> = []
    expect(restoreSettingsMobileListFocus(navigation, (callback: () => void) => scheduled.push(callback))).toBe(true)
    expect(document.activeElement).toBe(back)
    scheduled[0]?.()
    expect(document.activeElement).toBe(selected)
  })
})
