import path from "node:path"
import { RuntimeContext } from "../../../src/lifecycle/context"
import { registerAgentWorkerEntrypoint, spawnAgentWorkerProcess } from "../../../src/session/agent-turn/process-host"
import {
  registerPolicyWorkerEntrypoint,
  spawnPolicyWorkerProcess,
} from "../../../src/enforcement/policy-worker/process-host"

if (process.env.SYNERGY_AGENT_WORKER === "1" || process.env.SYNERGY_POLICY_WORKER === "1") {
  await Bun.write(
    process.env.SYNERGY_WORKER_ENV_RESULT!,
    JSON.stringify({
      cwd: process.cwd(),
      explicit: process.env.EXPLICIT_WORKER_VALUE,
      parent: process.env.PARENT_PRIVATE_VALUE,
      home: process.env.HOME_PRIVATE_VALUE,
      preload: process.env.PRELOAD_PRIVATE_VALUE,
    }),
  )
} else {
  const [root, role] = process.argv.slice(2)
  const result = path.join(root!, "result.json")
  const owner = RuntimeContext.create({
    home: root!,
    root: root!,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SYNERGY_TEST_HOME: root,
      SYNERGY_WORKER_ENV_RESULT: result,
      EXPLICIT_WORKER_VALUE: "public",
    },
  })
  try {
    await owner.run(async () => {
      const entry = new URL(import.meta.url)
      if (role === "agent") registerAgentWorkerEntrypoint(entry)
      else registerPolicyWorkerEntrypoint(entry)
      const spawn = role === "agent" ? spawnAgentWorkerProcess : spawnPolicyWorkerProcess
      const worker = spawn({ onMessage() {}, onExit() {} })
      const timer = setTimeout(() => worker.process.kill(), 10_000)
      try {
        if ((await worker.process.exited) !== 0) throw new Error("Environment probe failed")
        console.log(await Bun.file(result).text())
      } finally {
        clearTimeout(timer)
        await worker.stop(100)
      }
    })
  } finally {
    owner.dispose()
  }
}
