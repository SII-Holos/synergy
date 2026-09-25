import { expect, test } from "bun:test"
import { installedWorkerCommand, installedWorkerEnvironment } from "../src/installed-launcher"

test("detached native supervisors receive only installation bootstrap variables", () => {
  const env = {
    SYNERGY_HOME: "/fixture",
    SYNERGY_RUNTIME_ROOT: "/fixture/data",
    SYNERGY_INSTALLATION_ROOT: "/fixture/code",
    SYNERGY_INSTALLATION_PIN: "pin",
    SYNERGY_LAUNCHER_COMMAND: "command",
  }
  expect(installedWorkerEnvironment({ ...env, SYNERGY_CONFIG_CONTENT: "private", API_KEY: "secret" })).toEqual(env)
  expect(installedWorkerEnvironment({ SYNERGY_HOME: undefined })).toEqual({})
})

test("installed workers cannot bypass their pinned generation through source entrypoints", () => {
  expect(installedWorkerCommand({}, "__agent-turn-runner")).toBeUndefined()
  const env = { SYNERGY_INSTALLATION_PIN: JSON.stringify({ id: crypto.randomUUID(), sha256: "a".repeat(64) }) }
  expect(() => installedWorkerCommand(env, "__agent-turn-runner")).toThrow("verified launcher")
  expect(
    installedWorkerCommand(
      { ...env, SYNERGY_LAUNCHER_COMMAND: '["bun","run","/launcher.js"]' },
      "__plugin-runtime-runner",
      ["/plugin.js"],
    ),
  ).toEqual(["bun", "run", "/launcher.js", "__plugin-runtime-runner", "/plugin.js"])
})
