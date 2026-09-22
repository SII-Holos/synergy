import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { Global } from "../../src/global"
import { RuntimeContext } from "../../src/lifecycle/context"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityResources } from "../../src/observability/resources"

export function resetObservabilityState() {
  clearObservabilityState()
  mkdirSync(path.join(Global.Path.state, "observability"), { recursive: true })
  ObservabilityConfig.refresh()
  return RuntimeContext.current().host.home
}

export function clearObservabilityState() {
  if (RuntimeContext.current().host.env.SYNERGY_OBSERVABILITY_INLINE !== "1")
    throw new Error("This fixture requires inline telemetry; worker tests must await their own shutdown")
  ObservabilityResources.stop()
  ObservabilityStore.close()
  rmSync(path.join(Global.Path.state, "observability"), { recursive: true, force: true })
  ObservabilityConfig.refresh()
}
