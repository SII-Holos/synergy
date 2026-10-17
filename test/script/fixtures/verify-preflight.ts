import { mock } from "bun:test"
import { appendFileSync } from "node:fs"

const root = process.env.VERIFY_FIXTURE_ROOT!
const catalog = await import("../../../script/ci/catalog")
mock.module("../../../script/ci/catalog", () => ({
  ...catalog,
  ROOT: root,
  catalog: async () => [{ id: "static", kind: "static", seconds: 1, pool: "linux", owners: [], needs: [] }],
  workspaceInputs: async () => [],
}))
mock.module("../../../script/gates", () => ({
  runGates: async () => {
    appendFileSync(`${root}/.artifacts/order.txt`, "static\n")
    return {
      gates: ["fixture"],
      failures:
        process.env.VERIFY_FIXTURE_FAIL === "1"
          ? [{ gate: "fixture", exitCode: 1, stderr: "controlled static failure" }]
          : [],
    }
  },
}))
