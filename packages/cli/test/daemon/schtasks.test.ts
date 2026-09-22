import { describe, expect, test } from "bun:test"
import path from "path"
import { DaemonPaths } from "@ericsanchezok/synergy-harness/util/daemon-paths"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("daemon.schtasks paths", () => {
  test("builds a Windows task script path under daemon state", () =>
    runtime.run(() => {
      const script = DaemonPaths.windowsTaskScript()
      expect(path.basename(script)).toBe("synergy.cmd")
    }))
})

afterRuntimeTests(() => runtime.close())
