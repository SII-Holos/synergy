import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Bonjour } from "bonjour-service"

const log = Log.create({ service: "mdns" })

export namespace MDNS {
  const runtimeState = RuntimeContext.state(() => ({
    bonjour: undefined as Bonjour | undefined,
    currentPort: undefined as number | undefined,
  }))

  export function publish(port: number, name = "synergy") {
    const instanceState = runtimeState()

    if (instanceState.currentPort === port) return
    if (instanceState.bonjour) unpublish()

    try {
      instanceState.bonjour = new Bonjour()
      const service = instanceState.bonjour.publish({
        name,
        type: "http",
        port,
        txt: { path: "/" },
      })

      service.on("up", () => {
        log.info("mDNS service published", { name, port })
      })

      service.on("error", (err) => {
        log.error("mDNS service error", { error: err })
      })

      instanceState.currentPort = port
    } catch (err) {
      log.error("mDNS publish failed", { error: err })
      if (instanceState.bonjour) {
        try {
          instanceState.bonjour.destroy()
        } catch {}
      }
      instanceState.bonjour = undefined
      instanceState.currentPort = undefined
    }
  }

  export function unpublish() {
    const instanceState = runtimeState()

    if (instanceState.bonjour) {
      try {
        instanceState.bonjour.unpublishAll()
        instanceState.bonjour.destroy()
      } catch (err) {
        log.error("mDNS unpublish failed", { error: err })
      }
      instanceState.bonjour = undefined
      instanceState.currentPort = undefined
      log.info("mDNS service unpublished")
    }
  }
}
