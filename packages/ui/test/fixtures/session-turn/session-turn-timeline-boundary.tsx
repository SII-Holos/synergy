import { TEST_AGENT_NAME } from "@ericsanchezok/synergy-testing/agent-fixture"
import { I18nProvider } from "@lingui/solid"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { TimelineDisplay } from "../../../src/components/session-turn.tsx"
import { setupI18n } from "../../../src/testing/i18n.tsx"

const i18n = setupI18n()
const sessionID = "boundary-session"
const message = {
  id: "assistant-boundary",
  sessionID,
  role: "assistant",
  parentID: "user-boundary",
  rootID: "user-boundary",
  mode: "test",
  agent: TEST_AGENT_NAME,
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: "model",
  providerID: "provider",
  time: { created: 1, completed: 2 },
  finish: "stop",
}
const stableBasePart = {
  id: "reasoning-stable",
  sessionID,
  messageID: message.id,
  type: "reasoning",
  text: "seed",
}
const rawExplodingPart = {
  id: "reasoning-exploding",
  sessionID,
  messageID: message.id,
  type: "reasoning",
  text: "unused",
}
// A part object whose accessors throw once its owning reactive boundary
// is stale, mirroring the disposed Switch guard reads from the
// session-switch crash.
let stale = false
let proxyReads = 0
let throws = 0
const explodingPart = new Proxy(rawExplodingPart, {
  get(target, property, receiver) {
    if (property === "text") {
      proxyReads++
      if (stale) {
        throws++
        throw new Error("Stale read from <Switch>.")
      }
    }
    return Reflect.get(target, property, receiver)
  },
})

let setStableTick: (value: number) => void
let setExplodingTick: (value: number) => void

function StableTimeline() {
  const [tick, setTick] = createSignal(0)
  setStableTick = setTick
  // The app replaces streaming part objects on every reconcile tick, so
  // the display item is a fresh reference on every read.
  const item = () => ({
    kind: "passthrough",
    item: { kind: "reasoning", message, part: { ...stableBasePart, text: "Stable line " + tick() } },
    message,
  })
  return (
    <I18nProvider i18n={i18n}>
      <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
    </I18nProvider>
  )
}

function ExplodingTimeline() {
  const [tick, setTick] = createSignal(0)
  setExplodingTick = setTick
  // Reading tick() keeps the item reactive: every tick replaces the
  // display item reference, mirroring reconcile of a streaming part.
  const item = () => ({
    kind: "passthrough",
    item: { kind: "reasoning", message, part: explodingPart, tick: tick() },
    message,
  })
  return (
    <I18nProvider i18n={i18n}>
      <TimelineDisplay item={item()} serverUrl="http://localhost" working={false} compactReasoning />
    </I18nProvider>
  )
}

render(() => <StableTimeline />, document.querySelector("#root-stable"))
render(() => <ExplodingTimeline />, document.querySelector("#root-exploding"))

globalThis.__timelineBoundaryHarness = {
  setStableTick: (value: number) => setStableTick(value),
  setExplodingTick: (value: number) => setExplodingTick(value),
  setStale: (value: boolean) => {
    stale = value
  },
  getProxyReads: () => proxyReads,
  getThrows: () => throws,
}
