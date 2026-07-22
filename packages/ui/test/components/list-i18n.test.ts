import { describe, expect, test } from "bun:test"

const listSource = await Bun.file(new URL("../../src/components/list.tsx", import.meta.url)).text()

describe("List component i18n", () => {
  test("imports useLingui from @lingui/solid", () => {
    expect(listSource).toInclude('from "@lingui/solid"')
    expect(listSource).toInclude("useLingui")
  })

  test("empty-state messages are Lingui descriptors consumed via _()", () => {
    // Descriptors must be module-level, not _() called at module load.
    // The source must contain descriptor id patterns like "ui.list.loading".
    expect(listSource).toInclude('"ui.list.loading"')
    expect(listSource).toInclude('"ui.list.noResults"')
    // _() must be called at consumption time inside the component, not module-level.
    // Check that module-level _() with those IDs does NOT exist by confirming
    // the ID strings appear within descriptor objects {id: "..."}, not as direct args to _().
    expect(listSource).toInclude('{ id: "ui.list.loading"')
  })
})
