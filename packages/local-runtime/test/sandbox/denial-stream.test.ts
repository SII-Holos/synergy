import { expect, spyOn, test } from "bun:test"
import { startDenialLogger } from "../../src/sandbox/macos-diagnostics"

test("denial stream joins split records and bounds retained records for its child", async () => {
  const first = "Sandbox: fixture(123) deny(1) file-write-create /fixture/"
  const rest =
    "nested/file\n" +
    Array.from({ length: 300 }, (_, i) => `Sandbox: fixture(999) deny(1) file-read-data /other/${i}\n`).join("")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "await Bun.write(Bun.stdout, process.argv[1]); await Bun.sleep(80); await Bun.write(Bun.stdout, process.argv[2]);",
      first,
      rest,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const spawn = spyOn(Bun, "spawn").mockReturnValue(child)
  const logger = startDenialLogger()
  spawn.mockRestore()
  logger.adoptPid(123)
  try {
    await child.exited
    await logger.flush(0)
    expect(logger.output).toEqual([first + "nested/file"])
  } finally {
    logger.stop()
    child.kill()
  }
})

test("denial stream keeps bounded evidence under sustained denials", async () => {
  const records = Array.from(
    { length: 600 },
    (_, i) => `Sandbox: fixture(123) deny(1) file-write-create /fixture/${i}\n`,
  ).join("")
  const child = Bun.spawn([process.execPath, "-e", "await Bun.write(Bun.stdout, process.argv[1])", records], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const spawn = spyOn(Bun, "spawn").mockReturnValue(child)
  const logger = startDenialLogger()
  spawn.mockRestore()
  logger.adoptPid(123)
  try {
    await child.exited
    await logger.flush(0)
    expect(logger.output.length).toBeGreaterThan(0)
    expect(logger.output.length).toBeLessThanOrEqual(256)
  } finally {
    logger.stop()
    child.kill()
  }
})
