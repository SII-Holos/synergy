import { afterEach, describe, expect, test } from "bun:test"
import { BrowserElectronHostProcess } from "../../src/browser/electron-host-process.js"

const originalAutostart = process.env.SYNERGY_BROWSER_HOST_AUTOSTART

describe("BrowserElectronHostProcess", () => {
  afterEach(() => {
    if (originalAutostart === undefined) {
      delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART
    } else {
      process.env.SYNERGY_BROWSER_HOST_AUTOSTART = originalAutostart
    }
  })

  test("autostarts Browser Hosts by default", () => {
    delete process.env.SYNERGY_BROWSER_HOST_AUTOSTART

    expect(BrowserElectronHostProcess.enabled()).toBe(true)
  })

  test("can disable Browser Host autostart explicitly", () => {
    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "0"
    expect(BrowserElectronHostProcess.enabled()).toBe(false)

    process.env.SYNERGY_BROWSER_HOST_AUTOSTART = "false"
    expect(BrowserElectronHostProcess.enabled()).toBe(false)
  })
})
