import { afterEach, expect, spyOn, test } from "bun:test"
import { installBrowserDependencies } from "../src/install-deps-runner"
import { PlaywrightRuntime } from "../src/playwright-runtime"
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(() => Object.defineProperty(process, "platform", descriptor))

test("dependency installation rejects unsupported platforms before invoking an installer", async () => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
  await expect(installBrowserDependencies()).rejects.toThrow("only available on Linux")
})

test("Linux installation delegates to the packaged Playwright dependency installer", async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  const installer = spyOn(PlaywrightRuntime, "installChromiumDependencies").mockResolvedValue(undefined)
  try {
    await installBrowserDependencies()
    expect(installer).toHaveBeenCalledTimes(1)
  } finally {
    installer.mockRestore()
  }
})
