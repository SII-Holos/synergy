// Streaming wire protocol (issue #350 D1).
//
// The in-process Bus publishes `message.part.updated` with the *full accumulated
// part* on every streamed text/reasoning delta. Broadcasting that full part to
// every connected client on every delta is O(N²) in wire bytes and serialization
// for a long streamed reply (#350 H1). In-process subscribers keep receiving the
// full part (they hold object references, no serialization cost); only the
// client wire encoding is rewritten here.
//
// A delta-capable client (opted in with `?stream=delta`) receives:
//   - a compact `message.part.delta` frame carrying only the increment, for most
//     deltas — O(delta) bytes; and
//   - a full `message.part.updated` *checkpoint* frame at most once per
//     CHECKPOINT_MS per part (and always the terminal full write), so a client
//     that connected mid-stream, or drifted, converges within the interval.
// The two are mutually exclusive per delta event: a checkpoint already contains
// the delta's text, so we never send both (which would double-count on append).
//
// This relies on the #329 sequencer contract: streaming events are unsequenced,
// "coalescible and self-healing (a full part follows)", so the wire may drop or
// rewrite their payloads as long as a full part converges the client.
//
// The checkpoint throttle is per encoder instance: the WS route uses one shared
// encoder for all its delta clients (they receive identical frames), and each
// SSE connection owns its own. Sharing a single global map across independent
// transports would let one consumer's checkpoint decision corrupt another's.

export namespace EventWire {
  export const CHECKPOINT_MS = 1000

  export interface DeltaFrame {
    type: "message.part.delta"
    properties: {
      sessionID: string
      messageID: string
      partID: string
      kind: "text" | "reasoning"
      delta: string
    }
  }

  type WirePayload = {
    type?: string
    streaming?: boolean
    properties?: any
  }

  function isStreamingTextPart(part: any): boolean {
    return !!part && (part.type === "text" || part.type === "reasoning")
  }

  export interface Encoder {
    /**
     * Return the payload a delta-capable client should receive. Returns the SAME
     * reference to signal "send the full payload unchanged" (checkpoint,
     * terminal, or non-streaming event); returns a new compact
     * `message.part.delta` payload otherwise. Mutates internal checkpoint state,
     * so call exactly once per event on this encoder.
     */
    deltaPayload<T extends WirePayload>(payload: T, now?: number): T | DeltaFrame
    reset(): void
  }

  export function createEncoder(): Encoder {
    // partID -> last time a full checkpoint was emitted for it. Bounded by the
    // number of concurrently streaming parts; entries are cleared on the terminal
    // (no-delta) write for the part.
    const lastCheckpoint = new Map<string, number>()

    function shouldCheckpoint(partID: string, now: number): boolean {
      const last = lastCheckpoint.get(partID)
      if (last === undefined || now - last >= CHECKPOINT_MS) {
        lastCheckpoint.set(partID, now)
        return true
      }
      return false
    }

    return {
      deltaPayload(payload, now = Date.now()) {
        if (!payload || payload.type !== "message.part.updated") return payload
        const props = payload.properties
        const part = props?.part
        // Terminal write (no delta): send full and free the throttle slot.
        if (!payload.streaming || props?.delta === undefined) {
          if (part?.id) lastCheckpoint.delete(part.id)
          return payload
        }
        if (!isStreamingTextPart(part)) return payload
        // Checkpoint boundary (includes the first delta for a part): send the
        // full part so the client can create/replace it authoritatively.
        if (shouldCheckpoint(part.id, now)) return payload
        return {
          type: "message.part.delta",
          properties: {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            kind: part.type,
            delta: props.delta,
          },
        }
      },
      reset() {
        lastCheckpoint.clear()
      },
    }
  }
}
