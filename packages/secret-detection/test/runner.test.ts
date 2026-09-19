import { expect, test } from "bun:test"

test.each([false, true])("evaluation CLI emits a versioned report with an explicit adapter=%s", async (custom) => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../script/evaluate.ts", import.meta.url).pathname,
      "--samples",
      "2",
      "--warmup",
      "0",
      ...(custom ? ["--detector", new URL("./fixtures/empty-detector.ts", import.meta.url).pathname] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  const report = JSON.parse(stdout)
  expect(report.schemaVersion).toBe(1)
  expect(report.evaluation.detector.id).toBe(custom ? "fixture-negative" : "standalone-regex")
  expect(report.dataset.sha256).toHaveLength(64)
  expect(report.timings).toHaveLength(9)
  expect(report.evaluation.metrics.expected).toBeGreaterThan(10)
  expect(stdout).not.toContain("ghp_")
})
