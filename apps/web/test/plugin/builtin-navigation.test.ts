import { describe, expect, mock, test } from "bun:test"

mock.module("@/locales/en/messages.po?lingui", () => ({ messages: {} }))
import { getBuiltinNavigation } from "../../src/plugin/registries/navigation-registry"

describe("built-in navigation loaders", () => {
  test("loads the localized Library module outside a component owner", async () => {
    await import("../../src/plugin/builtin-navigation")
    const loader = getBuiltinNavigation("library")?.loader

    expect(loader).toBeFunction()
    const module = await loader!()
    expect(module.default).toBeFunction()
  })
})
