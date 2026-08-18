import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityResources } from "../../src/observability/resources"

const homes: string[] = []
const originalHome = process.env.SYNERGY_TEST_HOME
const originalInline = process.env.SYNERGY_OBSERVABILITY_INLINE

export function resetObservabilityHome(prefix = "synergy-observability-") {
  const home = mkdtempSync(path.join(tmpdir(), prefix))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  // Existing observability/performance tests exercise the store contract, not
  // the worker transport; pin them to the inline write path so behavior is
  // unchanged. Worker-mode coverage lives in telemetry-worker.test.ts and
  // store-worker-mode.test.ts.
  process.env.SYNERGY_OBSERVABILITY_INLINE = "1"
  mkdirSync(path.join(home, ".synergy", "config", "synergy.d"), { recursive: true })
  mkdirSync(path.join(home, ".synergy", "state"), { recursive: true })
  mkdirSync(path.join(home, ".synergy", "log"), { recursive: true })
  ObservabilityResources.stop()
  ObservabilityStore.close()
  ObservabilityConfig.refresh()
  return home
}

export function cleanupObservabilityHomes() {
  ObservabilityResources.stop()
  ObservabilityStore.close()
  // Sibling tests refresh the shared config (e.g. disabled.test.ts pins
  // enabled:false) without restoring it; reset the cache so a later file in
  // the same worker re-evaluates the default and does not silently drop every
  // event it expects to observe.
  ObservabilityConfig.refresh()
  if (originalHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalHome
  if (originalInline === undefined) delete process.env.SYNERGY_OBSERVABILITY_INLINE
  else process.env.SYNERGY_OBSERVABILITY_INLINE = originalInline
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}
