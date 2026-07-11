import {
  BROWSER_PROTOCOL_VERSION,
  BrowserWebRTCMessageSchema,
  type BrowserWebRTCSignal,
} from "@ericsanchezok/synergy-browser"
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
  connectionId?: string
  generation: number
  viewerIceSequence: number
  hostIceSequence: number
}

function send(socket: BrowserWebRTCSocket, payload: Record<string, unknown>): void {
  const message = BrowserWebRTCMessageSchema.parse(payload)
  try {
    socket.send(JSON.stringify(message))
  } catch {}
}

export namespace BrowserWebRTCSignaling {
  const channels = new Map<string, Channel>()

  export function channelKey(owner: BrowserOwner.Info, pageId: string): string {
    return `${BrowserOwner.key(owner)}:page:${pageId}`
  }

  export function attachViewer(
    owner: BrowserOwner.Info,
    pageId: string,
    socket: BrowserWebRTCSocket,
    options: { hostReady: boolean },
  ): void {
    const channel = getChannel(owner, pageId)
    if (channel.viewer) {
      channel.viewer.socket.close(4001, "Browser viewer replaced")
      closeActiveConnection(channel, pageId, channel.host?.socket)
      channel.generation = -1
    }
    channel.viewer = { socket }
    if (channel.host && options.hostReady)
      send(socket, { type: "webrtc.host.ready", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId })
  }

  export function attachHost(
    owner: BrowserOwner.Info,
    pageId: string,
    socket: BrowserWebRTCSocket,
    options: { hostReady: boolean },
  ): void {
    const channel = getChannel(owner, pageId)
    if (channel.host) {
      channel.host.socket.close(4001, "Browser Host signaling replaced")
      closeActiveConnection(channel, pageId, channel.viewer?.socket)
    }
    channel.host = { socket }
    if (channel.viewer && options.hostReady)
      send(channel.viewer.socket, { type: "webrtc.host.ready", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId })
  }

  export function detachViewer(owner: BrowserOwner.Info, pageId: string, socket: BrowserWebRTCSocket): void {
    const key = channelKey(owner, pageId)
    const channel = channels.get(key)
    if (!channel || channel.viewer?.socket !== socket) return
    channel.viewer = undefined
    if (channel.connectionId && channel.host) {
      send(channel.host.socket, {
        type: "webrtc.close",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId,
        connectionId: channel.connectionId,
        generation: channel.generation,
      })
    }
    clearConnection(channel)
    channel.generation = -1
    deleteIfEmpty(key, channel)
  }

  export function detachHost(owner: BrowserOwner.Info, pageId: string, socket: BrowserWebRTCSocket): void {
    const key = channelKey(owner, pageId)
    const channel = channels.get(key)
    if (!channel || channel.host?.socket !== socket) return
    channel.host = undefined
    if (channel.viewer) {
      closeActiveConnection(channel, pageId, channel.viewer.socket)
      send(channel.viewer.socket, { type: "webrtc.host.pending", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId })
    }
    deleteIfEmpty(key, channel)
  }

  export function handleViewerMessage(
    owner: BrowserOwner.Info,
    pageId: string,
    socket: BrowserWebRTCSocket,
    message: BrowserWebRTCSignal,
  ): void {
    const channel = getChannel(owner, pageId)
    if (channel.viewer?.socket !== socket) return
    if (message.type === "webrtc.offer") {
      if (message.generation < channel.generation) return
      if (
        message.generation === channel.generation &&
        channel.connectionId &&
        channel.connectionId !== message.connectionId
      )
        return
      channel.connectionId = message.connectionId
      channel.generation = message.generation
      channel.viewerIceSequence = -1
      channel.hostIceSequence = -1
    } else if (!matches(channel, message)) {
      return
    }
    if (message.type === "webrtc.ice") {
      if (message.sequence <= channel.viewerIceSequence) return
      channel.viewerIceSequence = message.sequence
    }
    if (!channel.host) {
      send(socket, { type: "webrtc.host.pending", protocolVersion: BROWSER_PROTOCOL_VERSION, pageId })
      return
    }
    send(channel.host.socket, message)
    if (message.type === "webrtc.close") clearConnection(channel)
  }

  export function handleHostMessage(owner: BrowserOwner.Info, pageId: string, message: BrowserWebRTCSignal): void {
    const channel = getChannel(owner, pageId)
    if (!channel.viewer || !matches(channel, message)) return
    if (message.type === "webrtc.ice") {
      if (message.sequence <= channel.hostIceSequence) return
      channel.hostIceSequence = message.sequence
    }
    if (message.type === "webrtc.offer") return
    send(channel.viewer.socket, message)
    if (message.type === "webrtc.close") clearConnection(channel)
  }

  export function acceptsRole(role: "viewer" | "host", message: BrowserWebRTCSignal): boolean {
    return role === "viewer"
      ? message.type === "webrtc.offer" || message.type === "webrtc.ice" || message.type === "webrtc.close"
      : message.type === "webrtc.answer" ||
          message.type === "webrtc.ice" ||
          message.type === "webrtc.close" ||
          message.type === "webrtc.error"
  }

  export function resetForTest(): void {
    channels.clear()
  }

  function getChannel(owner: BrowserOwner.Info, pageId: string): Channel {
    const key = channelKey(owner, pageId)
    const existing = channels.get(key)
    if (existing) return existing
    const channel: Channel = { generation: -1, viewerIceSequence: -1, hostIceSequence: -1 }
    channels.set(key, channel)
    return channel
  }

  function matches(channel: Channel, message: BrowserWebRTCSignal): boolean {
    return channel.connectionId === message.connectionId && channel.generation === message.generation
  }

  function clearConnection(channel: Channel): void {
    channel.connectionId = undefined
    channel.viewerIceSequence = -1
    channel.hostIceSequence = -1
  }

  function closeActiveConnection(channel: Channel, pageId: string, socket?: BrowserWebRTCSocket): void {
    if (channel.connectionId && socket) {
      send(socket, {
        type: "webrtc.close",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        pageId,
        connectionId: channel.connectionId,
        generation: channel.generation,
      })
    }
    clearConnection(channel)
  }

  function deleteIfEmpty(key: string, channel: Channel): void {
    if (!channel.viewer && !channel.host) channels.delete(key)
  }
}
