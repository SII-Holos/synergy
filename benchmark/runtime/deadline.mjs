import { readFile } from "node:fs/promises"

export function executionDeadline({ marker, startupSeconds, agentSeconds, onTimeout, pollMs = 100 }) {
  if (!(startupSeconds > 0 && agentSeconds > 0 && pollMs > 0)) throw new Error("Invalid execution deadlines")
  const state = { startup_started_at: Date.now(), model_started_at: null, timeout_stage: null, marker_error: null }
  let active = true
  let pending
  let agentTimer
  const fail = (stage) => {
    if (!active) return
    active = false
    state.timeout_stage = stage
    clearTimeout(startupTimer)
    clearTimeout(agentTimer)
    clearInterval(poll)
    onTimeout(stage)
  }
  async function observe() {
    if (state.model_started_at !== null) return
    try {
      const value = JSON.parse(await readFile(marker, "utf8"))
      if (!Number.isFinite(value.started_at) || value.started_at < state.startup_started_at)
        throw new Error("Invalid model start marker")
      state.model_started_at = value.started_at
      if (!active) return
      clearTimeout(startupTimer)
      agentTimer = setTimeout(
        () => fail("agent"),
        Math.max(1, agentSeconds * 1000 - Math.max(0, Date.now() - value.started_at)),
      )
      clearInterval(poll)
    } catch (error) {
      if (error.code !== "ENOENT") {
        state.marker_error = error.name
        fail("startup")
      }
    }
  }
  function inspect() {
    pending ??= observe().finally(() => {
      pending = undefined
    })
    return pending
  }
  const poll = setInterval(inspect, pollMs)
  const startupTimer = setTimeout(async () => {
    await inspect()
    if (state.model_started_at === null) fail("startup")
  }, startupSeconds * 1000)
  return {
    state,
    async stop() {
      active = false
      clearTimeout(startupTimer)
      clearTimeout(agentTimer)
      clearInterval(poll)
      await pending
      await observe()
    },
  }
}
