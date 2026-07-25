import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkLog } from "../src/log"
import { SynergyLinkStore } from "../src/state/store"

const originalHome = process.env.SYNERGY_LINK_HOME
const roots: string[] = []

afterEach(async () => {
  SynergyLinkLog.configure({ printToConsole: true })
  if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
  else process.env.SYNERGY_LINK_HOME = originalHome
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link persistent log", () => {
  test("persists operational metadata without user content or local paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-log-test-"))
    roots.push(root)
    process.env.SYNERGY_LINK_HOME = root
    SynergyLinkLog.configure({ printToConsole: false })

    SynergyLinkLog.info("test.sanitized", {
      requestID: "request_test",
      tool: "bash",
      action: "execute",
      command: "sensitive command",
      data: "sensitive stdin",
      keys: ["sensitive key"],
      output: "sensitive output",
      payload: { secret: "sensitive payload" },
      result: { output: "sensitive result" },
      label: "sensitive label",
      socketPath: path.join(root, "control.sock"),
      filePath: path.join(root, "private.txt"),
      details: { nestedToken: "sensitive nested token", nested: { agentSecret: "sensitive nested secret" } },
    })
    await SynergyLinkLog.flush()

    const logPath = SynergyLinkStore.logsPath()
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("request_test")
    expect(log).toContain('"tool":"bash"')
    expect(log).not.toContain("sensitive")
    expect(log).not.toContain(root)
    expect((await stat(logPath)).mode & 0o777).toBe(0o600)
  })
})
