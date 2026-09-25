import { expect, test } from "bun:test"
import { installedWorkerCommand } from "../src/installed-launcher"

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
