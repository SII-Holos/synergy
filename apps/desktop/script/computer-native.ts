import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  assert,
  eventually,
  startFixture,
  stageManagerEnabled,
  stayedInBackground,
  type Check,
  type Oracle,
} from "./computer-fixture"
import { ComputerDriver } from "../src/computer/driver"

class CaptureUnavailable extends Error {}

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
      report.checks.push({
        name,
        status: error instanceof CaptureUnavailable ? "blocked" : "fail",
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (fixture)
        await Bun.write(
          path.join(directory, `checkpoint-${report.checks.length}.json`),
          JSON.stringify(await fixture.command("refresh"), null, 2),
        )
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
    const observe = async (foreground = false) => {
      const result = await driver!.execute("native-acceptance", {
        type: "observe",
        pid: initial.pid,
        windowId: target.windowId,
        foreground,
      })
      await Bun.write(
        path.join(directory, `observation-${++observationSequence}.json`),
        JSON.stringify({ ...result, images: [] }, null, 2),
      )
      if (result.images[0])
        await Bun.write(path.join(directory, "window.png"), Buffer.from(result.images[0].data, "base64"))
      return result
    }
    const element = (output: string, name: string) => {
      let index: number | undefined
      for (const line of output.split("\n")) {
        const match = line.match(/^\s*- \[(\d+)\]/)
        if (match) index = Number(match[1])
        if (index !== undefined && line.includes(name)) return { elementIndex: index }
      }
      throw Error(`Element missing: ${name}`)
    }
    const act = async (
      input: import("@ericsanchezok/synergy-computer-protocol").ComputerAction,
      observed: Awaited<ReturnType<typeof observe>>,
    ) => {
      const result = await driver!.execute("native-acceptance", {
        type: "action",
        input,
        imageReceipt: {
          callID: "native-fixture-no-model",
          sha256: observed.observation?.image.sha256 ? [observed.observation.image.sha256] : [],
        },
      })
      await Bun.write(path.join(directory, `action-${observationSequence}.json`), JSON.stringify(result, null, 2))
      return result
    }
    const pixels = async (foreground = true) => {
      const observed = await eventually(
        () => observe(foreground),
        (value) => value.observation?.image.status === "valid",
        8000,
      )
      if (observed.observation?.image.status !== "valid")
        throw new CaptureUnavailable(
          JSON.stringify(observed.metadata.computerDiagnostics ?? observed.observation?.image),
        )
      const current = (await command("refresh")).windows[0]!
      const image = observed.observation.image
      return {
        observed,
        point: {
          x: Math.round((current.targetX * image.width!) / current.width),
          y: Math.round((current.targetY * image.height!) / current.height),
        },
      }
    }
    const background = async () => {
      await command("background", { pid: initial.frontmost })
      await eventually(
        () => command("refresh"),
        (value) => value.frontmost === initial.frontmost,
      )
      await Bun.sleep(1000)
      return command("refresh")
    }
    if (!report.stageManager)
      await check("first foreground canvas click raises the exact background window before dispatch", async () => {
        const { observed, point } = await pixels(false)
        const before = await command("refresh")
        assert(before.frontmost !== initial.pid, "The first-click fixture was already foreground")
        await act(
          { action: "click", observationId: observed.observationId!, target: point, foreground: true },
          observed,
        )
        const after = await eventually(
          () => command("refresh"),
          (value) => value.windows[0]!.hits === 1,
        )
        assert(after.windows[1]!.hits === 0, "The first foreground click reached the sibling window")
        assert(after.frontmost === before.frontmost, "Cua did not restore the previous foreground application")
      })
    await check("background observation and explicit foreground recovery", async () => {
      const before = await command("refresh")
      const observed = await observe()
      assert(stayedInBackground(before, await command("refresh")), "Background observation activated the target")
      if (observed.observation?.image.status !== "valid")
        assert(observed.images.length === 0, "Invalid image was delivered")
      const recovered = await observe(true)
      assert(recovered.metadata.deliveryMode === "foreground", "Foreground mode missing")
      assert(recovered.observation?.image.status === "valid", "Foreground capture did not recover")
      assert(
        recovered.output.includes(target.axToken) && !recovered.output.includes(other.axToken),
        "AX evidence is not bound to the target window",
      )
      assert(
        !recovered.output.includes(target.nonce) && !recovered.output.includes("AXMenuBar"),
        "Non-window content leaked into AX text",
      )
      assert(Buffer.byteLength(recovered.output) <= 32768, "Observation exceeds its text budget")
    })
    if (report.stageManager)
      await check("Stage Manager rejects thumbnails without AX and recovers in foreground", async () => {
        await background()
        permissions.accessibility = false
        try {
          const observed = await observe()
          assert(
            observed.images.length === 0 && observed.observation?.image.status !== "valid",
            "A Stage Manager thumbnail was delivered without AX proof",
          )
        } finally {
          permissions.accessibility = true
        }
        const recovered = await eventually(
          () => observe(true),
          (value) => value.images.length === 1,
          8000,
        )
        assert(recovered.metadata.deliveryMode === "foreground", "Recovery did not report foreground")
      })
    await check("capture remains available without accessibility results", async () => {
      permissions.accessibility = false
      try {
        const observed = await observe()
        assert(
          observed.observation?.ax.status === "unavailable" && observed.images.length === 1,
          "Capture incorrectly depends on AX content",
        )
      } finally {
        permissions.accessibility = true
      }
    })
    await check("background click, directed typing, value and scroll affect only the selected window", async () => {
      const before = await background()
      permissions.screen = false
      try {
        let observed = await observe()
        await act(
          { action: "click", observationId: observed.observationId!, target: element(observed.output, "Increment") },
          observed,
        )
        await eventually(
          () => command("refresh"),
          (value) => value.windows[0]!.clicks === 1,
        )
        observed = await observe()
        const typed = await act(
          {
            action: "type",
            observationId: observed.observationId!,
            target: element(observed.output, "Name"),
            text: "Synergy 你好",
          },
          observed,
        )
        assert(typed.metadata.route === "accessibility", "Native text fixture did not use exact AX insertion")
        await eventually(
          () => command("refresh"),
          (value) => value.windows[0]!.text === "Synergy 你好",
        )
        observed = await observe()
        await act(
          {
            action: "set_value",
            observationId: observed.observationId!,
            target: element(observed.output, "Level"),
            value: "65",
          },
          observed,
        )
        await eventually(
          () => command("refresh"),
          (value) => value.windows[0]!.value === 65,
        )
        permissions.screen = true
        observed = await observe()
        await act(
          {
            action: "scroll",
            observationId: observed.observationId!,
            target: element(observed.output, "Rows"),
            direction: "down",
            amount: 5,
          },
          observed,
        )
        const after = await eventually(
          () => command("refresh"),
          (value) => value.windows[0]!.scrollY > 0,
        )
        assert(
          after.windows[1]!.clicks === 0 &&
            after.windows[1]!.text === "" &&
            after.windows[1]!.value === 10 &&
            after.windows[1]!.scrollY === 0,
          "A sibling window was changed",
        )
        assert(stayedInBackground(before, after), "Semantic background operations disturbed focus")
      } finally {
        permissions.screen = true
      }
    })
    await check("covered window capture preserves exact content", async () => {
      await observe(true)
      await command("cover")
      const observed = await eventually(observe, (value) => value.images.length === 1, 8000)
      assert(
        observed.images.length === 1 &&
          observed.output.includes(target.axToken) &&
          !observed.output.includes(other.axToken),
        "Covered window observation was unavailable or selected the covering window",
      )
    })
    await check("foreground canvas click, double-click, right-click, key, shortcut and drag", async () => {
      for (const action of ["single", "double", "right", "key", "shortcut", "drag"] as const) {
        const { observed, point } = await pixels()
        const before = (await command("refresh")).windows[0]!
        const common = { observationId: observed.observationId!, foreground: true }
        const input: import("@ericsanchezok/synergy-computer-protocol").ComputerAction =
          action === "drag"
            ? { ...common, action: "drag", from: point, to: { x: point.x + 90, y: point.y }, durationSeconds: 0.5 }
            : action === "key"
              ? { ...common, action: "key", key: "return" }
              : action === "shortcut"
                ? { ...common, action: "key", key: "k", modifiers: ["cmd"] }
                : {
                    ...common,
                    action: "click",
                    target: point,
                    count: action === "double" ? 2 : 1,
                    button: action === "right" ? "right" : "left",
                  }
        const result = await act(input, observed)
        assert(result.metadata.deliveryMode === "foreground", "Executed foreground mode is not reported")
        const counter =
          action === "single"
            ? "hits"
            : action === "double"
              ? "doubleClicks"
              : action === "right"
                ? "rightClicks"
                : action === "key"
                  ? "keys"
                  : action === "shortcut"
                    ? "shortcuts"
                    : "drags"
        const after = await eventually(
          () => command("refresh"),
          (value) => value.windows[0]![counter] === before[counter] + 1,
        )
        assert(
          after.windows[1]!.hits === 0 &&
            after.windows[1]!.rightClicks === 0 &&
            after.windows[1]!.keys === 0 &&
            after.windows[1]!.drags === 0,
          "Foreground input reached the sibling window",
        )
      }
    })
    await check("resize and replacement reject stale observations without mutation", async () => {
      const observed = await observe()
      const targetElement = element(observed.output, "Increment")
      await command("resize", { width: 500 })
      const before = (await state()).windows[0]!.clicks
      const result = await act(
        { action: "click", observationId: observed.observationId!, target: targetElement, foreground: true },
        observed,
      ).then(
        () => "dispatched",
        (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
      )
      assert(
        result === "computer_observation_stale" || result === "computer_target_changed",
        `Expected stale refusal, got ${String(result)}`,
      )
      assert((await command("refresh")).windows[0]!.clicks === before, "Stale action changed the app")
      const old = await observe()
      await driver!.execute("another-task", { type: "observe", pid: initial.pid, windowId: target.windowId })
      const replaced = await act({ action: "key", observationId: old.observationId!, key: "return" }, old).then(
        () => "dispatched",
        (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
      )
      assert(replaced === "computer_observation_stale", "Replaced reference was reused")
    })
    await check("legitimate narrow windows remain usable", async () => {
      await command("resize", { width: 180 })
      const narrow = await eventually(
        () => observe(true),
        (value) => value.images.length === 1,
      )
      const current = (await state()).windows[0]!
      assert(current.width < 250 && narrow.observation?.image.status === "valid", "Narrow window was rejected")
    })
    await check("closed windows cannot admit actions", async () => {
      const previous = await observe()
      const targetElement = element(previous.output, "Increment")
      await command("close")
      const result = await act(
        { action: "click", observationId: previous.observationId!, target: targetElement },
        previous,
      ).then(
        () => "dispatched",
        (error: unknown) => (error instanceof Error && "code" in error ? error.code : "unknown"),
      )
      assert(
        [
          "computer_window_unavailable",
          "computer_observation_stale",
          "computer_target_changed",
          "computer_background_unavailable",
        ].includes(String(result)),
        `Closed window returned ${String(result)}`,
      )
    })
    report.status = report.checks.some((item) => item.status === "fail")
      ? "fail"
      : report.checks.some((item) => item.status === "blocked")
        ? "blocked"
        : "pass"
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
