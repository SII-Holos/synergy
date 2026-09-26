import { PlaywrightRuntime } from "./playwright-runtime"

export async function main() {
  if (typeof PlaywrightRuntime.load().chromium.launch !== "function")
    throw new Error("Packaged Playwright Chromium launcher is unavailable")
  console.log(`Playwright Core ${PlaywrightRuntime.version()}`)
}
