import { paintNature, stepNature, type Nature } from "./model"
import type { NatureCommand, NatureFrame } from "./protocol"

const channel = self as unknown as {
  onmessage: ((event: MessageEvent<NatureCommand>) => void) | null
  postMessage: (frame: NatureFrame) => void
}
let state: Nature | undefined
let generation = 0
let pending = false
let dirty = true
let timer: ReturnType<typeof setInterval> | undefined
function frame() {
  if (!state || pending || !dirty) return
  pending = true
  dirty = false
  channel.postMessage({ type: "frame", generation, state })
}
function stop() {
  clearInterval(timer)
  timer = undefined
}
channel.onmessage = ({ data }) => {
  if (data.type === "init") {
    stop()
    generation = data.generation
    state = data.state
    pending = false
    dirty = true
    frame()
    return
  }
  if (data.generation !== generation || !state) return
  if (data.type === "ack") {
    pending = false
    frame()
    return
  }
  if (data.type === "active") {
    stop()
    if (data.value)
      timer = setInterval(() => {
        if (state) stepNature(state)
        dirty = true
        frame()
      }, 1000 / 30)
  }
  if (data.type === "paint") {
    state = paintNature(state, data.tool, data.x, data.y)
    dirty = true
    frame()
  }
  if (data.type === "settings") {
    state.wind = data.wind
    state.lowGravity = data.lowGravity
  }
  if (data.type === "step") {
    for (let i = 0; i < 6; i++) stepNature(state)
    dirty = true
    frame()
  }
}
