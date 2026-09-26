import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("partitioned execution runs every suite once and emits matching JUnit, lcov, and timing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-ci-execution-"))
  try {
    await Bun.write(path.join(root, "src/value.ts"), "export const value = (x: number) => x + 1")
    for (let index = 0; index < 8; index++) {
      await Bun.write(
        path.join(root, `test/case-${index}.test.ts`),
        `
        import {test,expect} from "bun:test";
        import {value} from "../src/value";
        test("case-${index}",async()=>{
          expect(value(${index})).toBe(${index + 1});
          expect(process.env.SYNERGY_HOME).toBeUndefined();
          expect(process.env.SYNERGY_TEST_HOME).toBeTruthy();
          expect(process.env.SYNERGY_LINK_HOME).toStartWith(process.env.SYNERGY_TEST_ROOT!);
          const file=Bun.file("${index}.runs");
          await Bun.write(file,(await file.text().catch(()=>""))+process.env.SYNERGY_TEST_HOME+"\\n");
        })
      `,
      )
    }
    const runner = path.resolve(import.meta.dir, "../../script/run.ts")
    const codes = await Promise.all(
      Array.from({ length: 4 }, async (_, partition) => {
        const child = Bun.spawn([process.execPath, runner, "--coverage"], {
          cwd: root,
          env: {
            ...process.env,
            SYNERGY_TEST_PARTITION: String(partition),
            SYNERGY_TEST_PARTITIONS: "4",
            SYNERGY_HOME: "must-not-propagate",
          },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
        return code
      }),
    )
    expect(codes).toEqual([0, 0, 0, 0])
    const homes = new Set<string>()
    for (let index = 0; index < 8; index++) {
      const lines = (await Bun.file(path.join(root, `${index}.runs`)).text()).trim().split("\n")
      expect(lines).toHaveLength(1)
      homes.add(lines[0]!)
    }
    expect(homes.size).toBeGreaterThan(1)
    const reports = await Array.fromAsync(new Bun.Glob("coverage/shards/*/lcov.info").scan({ cwd: root }))
    expect(reports.length).toBeGreaterThan(1)
    for (const report of reports) {
      expect(await Bun.file(path.join(root, report.replace("lcov.info", "junit.xml"))).text()).toContain("<testcase")
      expect((await Bun.file(path.join(root, report.replace("lcov.info", "timing.json"))).json()).exitCode).toBe(0)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
