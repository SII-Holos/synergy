import { Server } from "../../../src/server/server"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import path from "node:path"

const home = process.env.SYNERGY_TEST_HOME!
const owner = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: process.env })
const reject = process.argv[2] === "reject"
const failure = new Error("Provider fixture failed")
let observed: unknown
try {
  const ready = await owner.run(() =>
    Server.resolveHealthModelReady({
      async list() {
        if (reject) throw failure
        return {}
      },
      listSettled: () => ({}),
      waitMs: 60_000,
      onError(error) {
        observed = error
      },
    }),
  )
  if (ready || (reject && observed !== failure)) throw new Error("Unexpected health result")
} finally {
  owner.dispose()
}
process.stdout.write("health-settled\n")
