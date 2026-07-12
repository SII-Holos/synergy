import {
  BROWSER_PROTOCOL_VERSION,
  BrowserEventSchema,
  type BrowserEvent as BrowserProtocolEvent,
} from "@ericsanchezok/synergy-browser"
import { SyncSequencer } from "../bus/sequencer.js"
import { BrowserOwner } from "./owner.js"

type SequencedEvent = Exclude<BrowserProtocolEvent, { type: "session.state" | "error" }>
type EventInput = SequencedEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "protocolVersion" | "seq" | "epoch">
    : never
  : never
type Listener = (event: BrowserProtocolEvent) => void

interface State {
  sequencer: SyncSequencer
  listeners: Set<Listener>
}

const states = new Map<string, State>()

export namespace BrowserEvent {
  export function publish<Input extends EventInput>(
    owner: BrowserOwner.Info,
    input: Input,
  ): Extract<SequencedEvent, { type: Input["type"] }> {
    const state = get(owner)
    const payload = {
      ...input,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      seq: 0,
      epoch: state.sequencer.epoch,
    }
    state.sequencer.stamp(payload, Date.now())
    const event = BrowserEventSchema.parse(payload)
    for (const listener of state.listeners) listener(event)
    return event as Extract<SequencedEvent, { type: Input["type"] }>
  }

  export function subscribe(owner: BrowserOwner.Info, listener: Listener): () => void {
    const state = get(owner)
    state.listeners.add(listener)
    return () => state.listeners.delete(listener)
  }

  export function watermark(owner: BrowserOwner.Info): { seq: number; epoch: string } {
    const sequencer = get(owner).sequencer
    return { seq: sequencer.current, epoch: sequencer.epoch }
  }

  export function replay(
    owner: BrowserOwner.Info,
    sinceSeq: number,
    epoch: string | undefined,
  ): BrowserProtocolEvent[] | null {
    const sequencer = get(owner).sequencer
    if (!epoch || epoch !== sequencer.epoch) return null
    const replay = sequencer.replay(sinceSeq, Date.now())
    if (replay.status === "reset") return null
    return replay.events.map((event) => BrowserEventSchema.parse(event))
  }

  export function remove(owner: BrowserOwner.Info): void {
    states.delete(BrowserOwner.key(owner))
  }

  export function resetForTest(): void {
    states.clear()
  }
}

function get(owner: BrowserOwner.Info): State {
  const key = BrowserOwner.key(owner)
  const existing = states.get(key)
  if (existing) return existing
  const state = { sequencer: new SyncSequencer(crypto.randomUUID()), listeners: new Set<Listener>() }
  states.set(key, state)
  return state
}
