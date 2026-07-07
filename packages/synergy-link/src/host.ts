import {
  SynergyLinkError,
  SynergyLinkIdentity,
  SynergyLinkHost as SynergyLinkHostProtocol,
} from "@ericsanchezok/synergy-link-protocol"
import { Platform } from "./platform"

export interface SynergyLinkHostOptions {
  linkID?: SynergyLinkIdentity.LinkID
  hostSessionID?: SynergyLinkIdentity.HostSessionID
  capabilities?: SynergyLinkHostProtocol.Capabilities
}

export class SynergyLinkHost {
  readonly linkID?: SynergyLinkIdentity.LinkID
  readonly hostSessionID: SynergyLinkIdentity.HostSessionID
  readonly capabilities: SynergyLinkHostProtocol.Capabilities

  constructor(options: SynergyLinkHostOptions = {}) {
    this.linkID = options.linkID
    this.hostSessionID = options.hostSessionID || crypto.randomUUID()
    this.capabilities = options.capabilities || Platform.detectCapabilities()
  }

  hello() {
    if (!this.linkID) {
      throw new Error("SynergyLinkHost requires linkID to emit Synergy Link host hello")
    }

    return {
      type: "synergy_link.host.hello" as const,
      linkID: this.linkID,
      hostSessionID: this.hostSessionID,
      capabilities: this.capabilities,
    }
  }

  assertLink(linkID: string) {
    if (!this.linkID || linkID === this.linkID) return

    throw SynergyLinkError.create("link_not_found", `link mismatch: host bound to ${this.linkID}, received ${linkID}`, {
      expectedLinkID: this.linkID,
      receivedLinkID: linkID,
    })
  }
}
