import path from "path"
import { Global } from "@/global"

export namespace ObservabilityPaths {
  export function dir() {
    return path.join(Global.Path.state, "observability")
  }

  export function pathName() {
    return path.join(dir(), "observability.sqlite")
  }

  export function legacyPerformancePath() {
    return path.join(dir(), "performance", "performance.sqlite")
  }
}
