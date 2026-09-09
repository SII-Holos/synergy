import { PlaywrightRuntime } from "./playwright-runtime"

export async function installBrowserDependencies() {
  if (process.platform !== "linux")
    throw new Error("Browser system dependency installation is only available on Linux.")
  await PlaywrightRuntime.installChromiumDependencies()
}

if (import.meta.main) await installBrowserDependencies()
