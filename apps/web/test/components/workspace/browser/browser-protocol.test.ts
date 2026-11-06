import { expect, test } from "bun:test"
import { BROWSER_PROTOCOL_VERSION, selectBrowserPresentation } from "@ericsanchezok/synergy-browser-core"
test("only a local native host selects a browser presentation", () => {
  expect(
    selectBrowserPresentation({ remote: false, desktopLocalHost: true, capabilities: { native: true } }),
  ).toMatchObject({ protocolVersion: BROWSER_PROTOCOL_VERSION, kind: "native" })
  expect(
    selectBrowserPresentation({ remote: false, desktopLocalHost: false, capabilities: { native: true } }),
  ).toBeNull()
  expect(
    selectBrowserPresentation({ remote: false, desktopLocalHost: true, capabilities: { native: false } }),
  ).toBeNull()
})
