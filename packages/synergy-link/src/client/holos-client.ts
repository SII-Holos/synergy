import { SynergyLinkHost, type SynergyLinkHostOptions } from "../host"
import type { HostTransport, RemoteHostIdentity } from "../types"

export interface HolosClientOptions extends SynergyLinkHostOptions {
  transport?: HostTransport
  label?: string
}

export class HolosClient {
  readonly host: SynergyLinkHost
  readonly transport?: HostTransport
  readonly label?: string

  constructor(options: HolosClientOptions = {}) {
    this.host = new SynergyLinkHost(options)
    this.transport = options.transport
    this.label = options.label
  }

  identity(): RemoteHostIdentity {
    if (!this.host.linkID) {
      throw new Error("HolosClient requires linkID to build identity")
    }

    return {
      linkID: this.host.linkID,
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
