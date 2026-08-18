import { describe, expect, test } from "bun:test"
import { Platform } from "../src/platform"

const ESC = "\u001b"

describe("synergy-link platform basics", () => {
  test("reports the bun runtime and posix shells", () => {
    expect(Platform.runtime()).toBe("bun")
    if (process.platform !== "win32") {
      expect(Platform.defaultShell()).toBe("sh")
      expect(Platform.supportedShells()).toEqual(["sh"])
    }
    const capabilities = Platform.detectCapabilities()
    expect(capabilities.platform).toBe(process.platform)
    expect(capabilities.arch).toBe(process.arch)
    expect(capabilities.runtime).toBe("bun")
    expect(capabilities.lineEndings).toBe(process.platform === "win32" ? "crlf" : "lf")
    expect(capabilities.supportsSendKeys).toBe(true)
    if (process.platform !== "win32") {
      expect(capabilities.supportsSoftKill).toBe(true)
      expect(capabilities.supportsProcessGroups).toBe(true)
      expect(capabilities.supportsBashDetach).toBe(true)
      expect(capabilities.envCaseInsensitive).toBe(false)
    }
  })

  test("normalizes environments and resolves shell launches on posix", () => {
    if (process.platform !== "win32") {
      expect(Platform.normalizeEnv({ A: "1", B: "2" })).toEqual({ A: "1", B: "2" })
      expect(Platform.resolveShellLaunch("echo hi")).toEqual({
        shell: "sh",
        file: "/bin/sh",
        args: ["-c", "echo hi"],
      })
    }
  })

  test("resolves absolute, relative, and default workdirs", () => {
    expect(Platform.resolveWorkdir()).toBe(process.cwd())
    expect(Platform.resolveWorkdir("/absolute")).toBe("/absolute")
    expect(Platform.resolveWorkdir("relative")).toBe(`${process.cwd()}/relative`.replace(/\/+/g, "/"))
  })

  test("sleep resolves after the requested duration", async () => {
    const started = Date.now()
    await Platform.sleep(10)
    expect(Date.now() - started).toBeGreaterThanOrEqual(5)
  })
})

describe("synergy-link key sequence encoding", () => {
  test("encodes named keys and caret control sequences", () => {
    expect(Platform.encodeKeySequence([])).toEqual({ data: "", warnings: [] })
    expect(Platform.encodeKeySequence([""])).toEqual({ data: "", warnings: [] })
    expect(Platform.encodeKeySequence([" "])).toEqual({ data: "", warnings: [] })

    expect(Platform.encodeKeySequence(["Enter"]).data).toBe("\r")
    expect(Platform.encodeKeySequence(["return"]).data).toBe("\r")
    expect(Platform.encodeKeySequence(["Tab"]).data).toBe("\t")
    expect(Platform.encodeKeySequence(["escape"]).data).toBe(ESC)
    expect(Platform.encodeKeySequence(["space"]).data).toBe(" ")
    expect(Platform.encodeKeySequence(["up"]).data).toBe(`${ESC}[A`)
    expect(Platform.encodeKeySequence(["down"]).data).toBe(`${ESC}[B`)
    expect(Platform.encodeKeySequence(["right"]).data).toBe(`${ESC}[C`)
    expect(Platform.encodeKeySequence(["left"]).data).toBe(`${ESC}[D`)
    expect(Platform.encodeKeySequence(["home"]).data).toBe(`${ESC}[1~`)
    expect(Platform.encodeKeySequence(["end"]).data).toBe(`${ESC}[4~`)
    expect(Platform.encodeKeySequence(["pageup"]).data).toBe(`${ESC}[5~`)
    expect(Platform.encodeKeySequence(["pagedown"]).data).toBe(`${ESC}[6~`)
    expect(Platform.encodeKeySequence(["insert"]).data).toBe(`${ESC}[2~`)
    expect(Platform.encodeKeySequence(["delete"]).data).toBe(`${ESC}[3~`)
    expect(Platform.encodeKeySequence(["f1"]).data).toBe(`${ESC}OP`)
    expect(Platform.encodeKeySequence(["f12"]).data).toBe(`${ESC}[24~`)
    expect(Platform.encodeKeySequence(["^C"]).data).toBe("\u0003")
    expect(Platform.encodeKeySequence(["^?"]).data).toBe("\u007f")
    expect(Platform.encodeKeySequence(["^c", "^d"]).data).toBe("\u0003\u0004")
  })

  test("encodes modifiers, alt, shift, and single characters", () => {
    expect(Platform.encodeKeySequence(["c-a"]).data).toBe("\u0001")
    expect(Platform.encodeKeySequence(["m-a"]).data).toBe(`${ESC}a`)
    expect(Platform.encodeKeySequence(["s-a"]).data).toBe("A")
    expect(Platform.encodeKeySequence(["c-m-x"]).data).toBe(`${ESC}\u0018`)
    expect(Platform.encodeKeySequence(["a"]).data).toBe("a")
    expect(Platform.encodeKeySequence(["A"]).data).toBe("A")
    expect(Platform.encodeKeySequence(["m-C"]).data).toBe(`${ESC}C`)
    expect(Platform.encodeKeySequence(["m-Enter"]).data).toBe(`${ESC}\r`)
  })

  test("warns about unknown keys and sends them literally", () => {
    expect(Platform.encodeKeySequence(["c-unknown"])).toEqual({
      data: "unknown",
      warnings: ['Unknown key "unknown" for modifiers; sending literal.'],
    })
    expect(Platform.encodeKeySequence(["xyz"])).toEqual({ data: "xyz", warnings: [] })
    expect(Platform.encodeKeySequence(["Enter", "c-bogus"]).data).toBe(`\rbogus`)
  })

  test("kills nothing when no owner markers or processes exist", async () => {
    await expect(Platform.killOwnedByMarkers([])).resolves.toBeUndefined()
    await expect(Platform.killOwnedByMarkers(["", "", ""])).resolves.toBeUndefined()
    await expect(Platform.killOwnedByMarker("marker_that_matches_nothing")).resolves.toBeUndefined()
  })
})
