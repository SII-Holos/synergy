import "@ericsanchezok/synergy-testing/preload"

const { Global } = await import("../../src/global")
await Global.initialize()
const { Log } = await import("../../src/util/log")
const { AgentTurn } = await import("../../src/session/agent-turn")
const { runInProcessStream } = await import("../../src/session/agent-turn/in-process")

Log.init({ print: false, dev: true, level: "DEBUG" })
AgentTurn.setInProcessStream(runInProcessStream)
