import { BrowserOwner } from "./owner.js"

export interface BrowserWebRTCSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

interface Peer {
  socket: BrowserWebRTCSocket
}

interface Channel {
  viewer?: Peer
  host?: Peer
}

function send(socket: BrowserWebRTCSocket, payload: Record<string, unknown>) {
  try {
    socket.send(JSON.stringify(payload))
  } catch {
    // Peer may have disconnected while a signaling message was in flight.
  }
}

export namespace BrowserWebRTCSignaling {
  const channels = new Map<string, Channel>()

  export function channelKey(owner: BrowserOwner.Info, tabId: string): string {
    return `${BrowserOwner.key(owner)}:tab:${tabId}`
  }

  export function attachViewer(owner: BrowserOwner.Info, tabId: string, socket: BrowserWebRTCSocket): void {
    const channel = getChannel(owner, tabId)
    channel.viewer = { socket }
    if (channel.host) send(socket, { type: "webrtc.host.ready", tabId })
  }

  export function attachHost(owner: BrowserOwner.Info, tabId: string, socket: BrowserWebRTCSocket): void {
    const channel = getChannel(owner, tabId)
    channel.host = { socket }
    if (channel.viewer) send(channel.viewer.socket, { type: "webrtc.host.ready", tabId })
  }

  export function detachViewer(owner: BrowserOwner.Info, tabId: string, socket: BrowserWebRTCSocket): void {
    const key = channelKey(owner, tabId)
    const channel = channels.get(key)
    if (!channel || channel.viewer?.socket !== socket) return
    channel.viewer = undefined
    deleteIfEmpty(key, channel)
  }

  export function detachHost(owner: BrowserOwner.Info, tabId: string, socket: BrowserWebRTCSocket): void {
    const key = channelKey(owner, tabId)
    const channel = channels.get(key)
    if (!channel || channel.host?.socket !== socket) return
    channel.host = undefined
    if (channel.viewer) {
      send(channel.viewer.socket, {
        type: "webrtc.host.pending",
        tabId,
        code: "browser_webrtc_host_disconnected",
        message: "Browser Host media transport disconnected.",
      })
    }
    deleteIfEmpty(key, channel)
  }

  export function handleViewerMessage(
    owner: BrowserOwner.Info,
    tabId: string,
    socket: BrowserWebRTCSocket,
    message: Record<string, unknown>,
  ): void {
    const channel = getChannel(owner, tabId)
    if (message.type === "webrtc.close") {
      if (channel.viewer?.socket !== socket) return
      if (channel.host) send(channel.host.socket, message)
      send(socket, { type: "webrtc.closed", tabId })
      return
    }

    if (message.type === "webrtc.offer") {
      channel.viewer = { socket }
    } else if (channel.viewer?.socket !== socket) {
      return
    }

    if (!channel.host) {
      send(socket, {
        type: "webrtc.host.pending",
        tabId,
        code: "browser_webrtc_host_not_attached",
        message: "Waiting for Browser Host media transport.",
      })
      return
    }

    send(channel.host.socket, message)
  }

  export function handleHostMessage(owner: BrowserOwner.Info, tabId: string, message: Record<string, unknown>): void {
    const channel = getChannel(owner, tabId)
    if (!channel.viewer) return
    send(channel.viewer.socket, message)
  }

  export function resetForTest(): void {
    channels.clear()
  }

  function getChannel(owner: BrowserOwner.Info, tabId: string): Channel {
    const key = channelKey(owner, tabId)
    const existing = channels.get(key)
    if (existing) return existing
    const channel: Channel = {}
    channels.set(key, channel)
    return channel
  }

  function deleteIfEmpty(key: string, channel: Channel): void {
    if (!channel.viewer && !channel.host) channels.delete(key)
  }
}
