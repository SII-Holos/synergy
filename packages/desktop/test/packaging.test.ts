import { describe, expect, test } from "bun:test"

interface ElectronBuilderConfig {
  extraResources?: Array<{
    from?: string
    to?: string
  }>
}

describe("desktop packaging", () => {
  test("copies runtime icon resources for explicit Windows and Linux window icons", async () => {
    const config = (await Bun.file(
      new URL("../electron-builder.json", import.meta.url),
    ).json()) as ElectronBuilderConfig

    expect(config.extraResources).toContainEqual({
      from: "build/icon.ico",
      to: "icons/icon.ico",
    })
    expect(config.extraResources).toContainEqual({
      from: "build/icon.png",
      to: "icons/icon.png",
    })
  })
})
