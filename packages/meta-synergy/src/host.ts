import { MetaProtocolEnv, MetaProtocolHost } from "@ericsanchezok/meta-protocol"
import { Platform } from "./platform"

export interface MetaSynergyHostOptions {
  envID?: MetaProtocolEnv.EnvID
  hostSessionID?: MetaProtocolEnv.HostSessionID
  capabilities?: MetaProtocolHost.Capabilities
}

export class MetaSynergyHost {
  readonly envID?: MetaProtocolEnv.EnvID
  readonly hostSessionID: MetaProtocolEnv.HostSessionID
  readonly capabilities: MetaProtocolHost.Capabilities

  constructor(options: MetaSynergyHostOptions = {}) {
    this.envID = options.envID
    this.hostSessionID = options.hostSessionID || crypto.randomUUID()
    this.capabilities = options.capabilities || Platform.detectCapabilities()
  }

  hello() {
    if (!this.envID) {
      throw new Error("MetaSynergyHost requires envID to emit host.hello")
    }

    return {
      type: "host.hello" as const,
      envID: this.envID,
      hostSessionID: this.hostSessionID,
      capabilities: this.capabilities,
    }
  }

  assertEnv(envID: string) {
    if (this.envID && envID !== this.envID) {
      throw new Error(`env mismatch: host bound to ${this.envID}, received ${envID}`)
    }
  }
}
