import { RuntimeContext } from "../../src/lifecycle/context"
const home = process.env.SYNERGY_HOME!
const root = process.env.SYNERGY_RUNTIME_ROOT!
const runtime = RuntimeContext.create({ home, root, env: { ...process.env } })
const { startPolicyWorker } = await import("../../src/enforcement/policy-worker/runner")
runtime.run(() => startPolicyWorker())
