import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityResources } from "../../src/observability/resources"

const homes: string[] = []
const originalHome = process.env.SYNERGY_TEST_HOME

export function resetObservabilityHome(prefix = "synergy-observability-") {
  ObservabilityResources.stop()
  ObservabilityStore.close()
  const home = mkdtempSync(path.join(tmpdir(), prefix))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  mkdirSync(path.join(home, ".synergy", "config", "synergy.d"), { recursive: true })
  mkdirSync(path.join(home, ".synergy", "state"), { recursive: true })
  mkdirSync(path.join(home, ".synergy", "log"), { recursive: true })
  ObservabilityConfig.refresh()
  return home
}

export function cleanupObservabilityHomes() {
  ObservabilityResources.stop()
  ObservabilityStore.close()
  if (originalHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}
