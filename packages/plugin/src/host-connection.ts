export interface PluginHostDescriptor {
  id: string
  version: string
  platform: string
  components: Array<{ id: string; version: string; apiVersion: 1 }>
  name: string
  publicKey: string
  url?: string
}

export interface PluginHostPeer extends PluginHostDescriptor {
  pairedAt: number
  connectionPath: string
}

export interface PluginHostPairingReceipt {
  requestID: string
  pairID: string
  requester: PluginHostDescriptor
  target: PluginHostDescriptor
  phase: "pending" | "approved"
  expiresAt: number
  signature: string
}

export interface PluginHostPairingPending {
  requestID: string
  direction: "incoming" | "outgoing"
  device: PluginHostDescriptor
  expiresAt: number
  phase: "pending" | "approved"
}

export interface HostConnectionHostService {
  endpoint(): Promise<{ url: string; generation: string }>
  configure(input: { enabled: boolean; name: string; url?: string }): Promise<PluginHostDescriptor>
  probe(input: { url: string }): Promise<PluginHostDescriptor>
  invite(): Promise<{ code: string; expiresAt: number }>
  pair(input: { target: PluginHostDescriptor; code: string }): Promise<PluginHostPairingReceipt>
  pending(): Promise<PluginHostPairingPending[]>
  approve(input: { requestID: string }): Promise<PluginHostPairingReceipt>
  finish(input: { requestID: string }): Promise<PluginHostPairingReceipt>
  peers(): Promise<PluginHostPeer[]>
  revoke(input: { hostID: string }): Promise<void>
}
