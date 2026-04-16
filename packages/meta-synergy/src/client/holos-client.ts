import { MetaSynergyHost, type MetaSynergyHostOptions } from "../host"
import type { HostTransport, RemoteHostIdentity } from "../types"

export interface HolosClientOptions extends MetaSynergyHostOptions {
  transport?: HostTransport
  label?: string
}

export class HolosClient {
  readonly host: MetaSynergyHost
  readonly transport?: HostTransport
  readonly label?: string

  constructor(options: HolosClientOptions = {}) {
    this.host = new MetaSynergyHost(options)
    this.transport = options.transport
    this.label = options.label
  }

  identity(): RemoteHostIdentity {
    if (!this.host.envID) {
      throw new Error("HolosClient requires envID to build identity")
    }

    return {
      envID: this.host.envID,
      hostSessionID: this.host.hostSessionID,
      capabilities: this.host.capabilities,
      label: this.label,
    }
  }

  async connect(): Promise<void> {
    if (!this.transport) {
      return
    }

    await this.transport.connect()
    await this.transport.send(this.host.hello())
  }

  async disconnect(): Promise<void> {
    if (!this.transport) {
      return
    }

    await this.transport.disconnect()
  }
}
