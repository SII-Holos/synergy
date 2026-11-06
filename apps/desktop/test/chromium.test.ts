import { expect, test } from "bun:test"
import { configureDesktopChromium } from "../src/chromium"

test.each([
  ["", "CDPScreenshotNewSurface"],
  ["OtherFeature,AnotherFeature", "OtherFeature,AnotherFeature,CDPScreenshotNewSurface"],
  ["OtherFeature,CDPScreenshotNewSurface", "OtherFeature,CDPScreenshotNewSurface"],
  ["CDPScreenshotNewSurface<Study:Mode/value,OtherFeature", "CDPScreenshotNewSurface<Study:Mode/value,OtherFeature"],
])("configures native screenshot rendering without replacing Chromium features: %s", (enabled, expected) => {
  const switches = new Map([
    ["enable-features", enabled],
    ["disable-features", "DisabledFeature"],
    ["other-switch", "unchanged"],
  ])
  const commandLine = {
    getSwitchValue: (name: string) => switches.get(name) ?? "",
    appendSwitch: (name: string, value?: string) => {
      switches.set(name, value ?? "")
    },
  }
  const app = { isReady: () => false, commandLine }
  configureDesktopChromium(app)
  configureDesktopChromium(app)
  expect(switches.get("enable-features")).toBe(expected)
  expect(switches.get("disable-features")).toBe("DisabledFeature")
  expect(switches.get("other-switch")).toBe("unchanged")
})

test("rejects Chromium configuration after Electron is ready without mutating switches", () => {
  const writes: string[] = []
  expect(() =>
    configureDesktopChromium({
      isReady: () => true,
      commandLine: {
        getSwitchValue: () => "",
        appendSwitch: (name: string) => {
          writes.push(name)
        },
      },
    }),
  ).toThrow("before Electron is ready")
  expect(writes).toEqual([])
})

test.each(["CDPScreenshotNewSurface", "OtherFeature, CDPScreenshotNewSurface<Study"])(
  "rejects an explicit capture feature disable instead of silently leaving capture broken: %s",
  (disabled) => {
    const writes: string[] = []
    expect(() =>
      configureDesktopChromium({
        isReady: () => false,
        commandLine: {
          getSwitchValue: (name: string) => (name === "disable-features" ? disabled : "CDPScreenshotNewSurface"),
          appendSwitch: (name: string) => {
            writes.push(name)
          },
        },
      }),
    ).toThrow("CDPScreenshotNewSurface cannot be disabled")
    expect(writes).toEqual([])
  },
)
