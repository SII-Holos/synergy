import "@ericsanchezok/synergy-testing/preload"

const { Global } = await import("../../src/global")
await Global.initialize()
const { Log } = await import("../../src/util/log")
const { AgentTurn } = await import("../../src/session/agent-turn")
const { runInProcessStream } = await import("../../src/session/agent-turn/in-process")

Log.init({ print: false, dev: true, level: "DEBUG" })
AgentTurn.setInProcessStream(runInProcessStream)

const { Storage } = await import("../../src/storage/storage")
const { TransactionalStore } = await import("../../src/storage/transactional-store")
const { beforeTestHomeDisposal } = await import("@ericsanchezok/synergy-testing/preload")
const storage = await TransactionalStore.open({
  backend: "sqlite",
  namespace: "test",
  filename: `${Global.Path.data}/storage/test.sqlite`,
})
const uninstallStorage = Storage.install({ store: storage, artifactDirectory: Global.Path.data })
beforeTestHomeDisposal(async () => {
  await storage.close()
  uninstallStorage()
})
