import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { assert, eventually, startFixture, stageManagerEnabled, type Check, type Oracle } from "./computer-fixture"
import { ComputerDriver } from "../src/computer/driver"

export type NativeReport = {
  version: 1
  kind: "native"
  status: "pass" | "fail" | "blocked"
  createdAt: string
  driverSha256?: string
  authority: string
  stageManager?: boolean
  displays?: Oracle["displays"]
  checks: Check[]
}

export async function runNativeAcceptance(options: { directory: string; driver: string }): Promise<NativeReport> {
  const directory = path.resolve(options.directory)
  await mkdir(directory, { recursive: true })
  const report: NativeReport = {
    version: 1,
    kind: "native",
    status: "blocked",
    createdAt: new Date().toISOString(),
    authority: "source test host; does not establish installed-app TCC grants",
    checks: [],
  }
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined
  let driver: ComputerDriver | undefined
  const permissions = { accessibility: true, screen: true }
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn()
      report.checks.push({ name, status: "pass" })
    } catch (error) {
      report.checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) })
    }
  }
  try {
    if (process.platform !== "darwin") throw Error("A logged-in macOS graphical session is required")
    const bytes = new Uint8Array(await Bun.file(options.driver).arrayBuffer())
    report.driverSha256 = createHash("sha256").update(bytes).digest("hex")
    fixture = await startFixture(directory)
    const { initial, state, command } = fixture
    report.displays = initial.displays
    report.stageManager = await stageManagerEnabled()
    driver = new ComputerDriver(options.driver, () => permissions)
    const target = initial.windows[0]!
    const other = initial.windows[1]!
    let observationSequence = 0
    const observe = async () => {
      const result = await driver!.execute("native-acceptance", {
        type: "observe",
        pid: initial.pid,
        windowId: target.windowId,
      })
      await Bun.write(
        path.join(directory, `observation-${++observationSequence}.json`),
        JSON.stringify({ ...result, images: [] }, null, 2),
      )
      return result
    }
    const first = await eventually(
      observe,
      (value) => value.observation?.ax.status !== "unavailable" && value.observation?.image.status === "valid",
      15_000,
    )
    assert(first.images[0], "Fixture image is unavailable; verify the source host's AX and Screen Recording grants")
    await Bun.write(path.join(directory, "window.png"), Buffer.from(first.images[0].data, "base64"))
    await Bun.write(path.join(directory, "observation.json"), JSON.stringify({ ...first, images: [] }, null, 2))
    await check("exact-window and canvas-only evidence", async () => {
      assert(first.output.includes(target.axToken), "Target AX content missing")
      assert(!first.output.includes(other.axToken), "Another window leaked into the observation")
      assert(!first.output.includes(target.nonce), "Canvas nonce leaked through AX text")
      assert(!first.output.includes("AXMenuBar"), "Application menu bar leaked into the window projection")
      assert(Buffer.byteLength(first.output) <= 32768, "Observation exceeds the UTF-8 budget")
      assert(
        first.observation!.image.width! / target.width === first.observation!.image.height! / target.height,
        "Image geometry differs from the logical window",
      )
    })
    await command("background")
    await eventually(
      observe,
      (value) => value.observation?.actions.click.available === true && value.observation?.image.status === "valid",
      15_000,
    )
    const foreground = (await command("refresh")).frontmost
    await check("AX-only semantic click changes only the target", async () => {
      permissions.screen = false
      try {
        const observation = await observe()
        assert(
          observation.images.length === 0 && observation.observation?.actions.click.available,
          "AX-only route was lost",
        )
        const index = observation.output.match(/\[(\d+)\].*Increment/)
        assert(index, "Increment element missing")
        await driver!.execute("native-acceptance", {
          type: "action",
          input: { action: "click", observationId: observation.observationId!, elementIndex: Number(index[1]) },
        })
        const after = await eventually(state, (value) => value.windows[0]!.clicks === 1)
        assert(after.windows[1]!.clicks === 0, "Wrong window changed")
        assert((await command("refresh")).frontmost === foreground, "Background action changed the foreground app")
      } finally {
        permissions.screen = true
      }
    })
    await check("image point dispatch uses the immutable capture", async () => {
      const observed = await observe()
      assert(observed.observation?.image.status === "valid", "Current representation cannot be verified for pixels")
      const image = observed.observation.image
      await driver!.execute("native-acceptance", {
        type: "action",
        input: {
          action: "point",
          observationId: observed.observationId!,
          x: Math.round((target.targetX * image.width!) / target.width),
          y: Math.round((target.targetY * image.height!) / target.height),
        },
        imageReceipt: { callID: "native-fixture-no-model", sha256: [image.sha256!] },
      })
      const after = await eventually(state, (value) => value.windows[0]!.hits === 1)
      assert(after.windows[1]!.hits === 0, "Point changed the other window")
      assert((await command("refresh")).frontmost === foreground, "Point changed the foreground app")
    })
    await check("resized target rejects an old observation", async () => {
      const observed = await observe()
      const index = observed.output.match(/\[(\d+)\].*Increment/)
      assert(index, "Increment element missing")
      await command("resize", { width: 500 })
      const before = (await state()).windows[0]!.clicks
      const result = await driver!
        .execute("native-acceptance", {
          type: "action",
          input: { action: "click", observationId: observed.observationId!, elementIndex: Number(index[1]) },
        })
        .then(
          () => "dispatched",
          (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
        )
      assert(result === "computer_target_changed", `Expected target change refusal, got ${String(result)}`)
      assert((await command("refresh")).windows[0]!.clicks === before, "A stale action mutated the app")
    })
    await check("replacement across tasks rejects the old reference", async () => {
      const old = await observe()
      await driver!.execute("another-task", { type: "observe", pid: initial.pid, windowId: target.windowId })
      const result = await driver!
        .execute("native-acceptance", {
          type: "action",
          input: { action: "key", observationId: old.observationId!, key: "return" },
        })
        .then(
          () => "dispatched",
          (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
        )
      assert(result === "computer_observation_stale", "Cross-task replacement reused a reference")
    })
    await check("legitimate narrow windows remain usable", async () => {
      await command("resize", { width: 180 })
      const narrow = await eventually(observe, (value) => value.observation?.image.status === "valid", 10_000)
      const current = (await state()).windows[0]!
      assert(current.width < 250, "Fixture did not become narrow")
      assert(narrow.images.length === 1, "A valid narrow window was rejected by an image-size heuristic")
    })
    await check("closed windows require rediscovery", async () => {
      await command("close")
      const result = await observe().then(
        () => "observed",
        (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
      )
      assert(result === "computer_window_unavailable", `Closed window returned ${String(result)}`)
    })
    report.status = report.checks.some((item) => item.status === "fail") ? "fail" : "pass"
  } catch (error) {
    report.checks.push({
      name: "native prerequisites",
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await driver?.close()
    await fixture?.close()
    await Bun.write(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
  }
  return report
}

if (import.meta.main) {
  const directory =
    process.env.SYNERGY_COMPUTER_REPORT_DIR ??
    path.resolve(import.meta.dir, "../../../.artifacts/computer-native", new Date().toISOString().replaceAll(":", "-"))
  const driver =
    process.env.SYNERGY_COMPUTER_DRIVER_PATH ?? path.resolve(import.meta.dir, "../build/computer/cua-driver")
  const report = await runNativeAcceptance({ directory, driver })
  console.log(JSON.stringify({ ...report, directory }, null, 2))
  process.exitCode = report.status === "pass" ? 0 : report.status === "blocked" ? 2 : 1
}
