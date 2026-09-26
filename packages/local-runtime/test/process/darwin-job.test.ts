import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { DarwinJob } from "../../src/process/darwin-job"

test.skipIf(process.platform !== "darwin")(
  "launchd receives the explicit worker bootstrap environment",
  async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "environment.json")
    const env = { SYNERGY_HOME: tmp.path, SYNERGY_INSTALLATION_PIN: '{"id":"fixture&<>"}' }
    const job = await DarwinJob.start(
      [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({home:process.env.SYNERGY_HOME,pin:process.env.SYNERGY_INSTALLATION_PIN}));await new Promise(()=>{})`,
      ],
      tmp.path,
      env,
    )
    try {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await Bun.file(marker).exists()) break
        await Bun.sleep(20)
      }
      expect(await Bun.file(marker).json()).toEqual({ home: env.SYNERGY_HOME, pin: env.SYNERGY_INSTALLATION_PIN })
      expect((await fs.readFile(path.join(tmp.path, "job.plist"), "utf8")).includes("fixture&amp;&lt;&gt;")).toBe(true)
    } finally {
      await job.remove()
    }
  },
  20_000,
)
