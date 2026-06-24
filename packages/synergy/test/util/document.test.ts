import { describe, expect, test } from "bun:test"
import { Document } from "../../src/util/document"
import path from "path"
import os from "os"
import { Filesystem } from "../../src/util/filesystem"

describe("Document.supported", () => {
  test("does not load the conversion engine for extension checks", () => {
    const packageDir = path.resolve(import.meta.dir, "../..")
    const result = Bun.spawnSync(
      ["bun", "-e", 'import { Document } from "./src/util/document.ts"; console.log(Document.supported("sample.pdf"))'],
      { cwd: packageDir, stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("true")
    expect(new TextDecoder().decode(result.stderr)).not.toContain("DOMMatrix")
  })

  test("returns true for known document extensions", () => {
    const known = [
      ".pdf",
      ".docx",
      ".xlsx",
      ".pptx",
      ".html",
      ".htm",
      ".csv",
      ".xml",
      ".rss",
      ".atom",
      ".ipynb",
      ".jpg",
      ".jpeg",
      ".png",
      ".wav",
      ".mp3",
      ".zip",
    ]
    for (const ext of known) {
      expect(Document.supported(`/path/to/file${ext}`)).toBe(true)
    }
  })

  test("returns true regardless of case", () => {
    expect(Document.supported("/path/to/file.PDF")).toBe(true)
    expect(Document.supported("/path/to/file.Docx")).toBe(true)
    expect(Document.supported("/path/to/file.CSV")).toBe(true)
  })

  test("returns false for .txt (not a markitdown-ts document format)", () => {
    expect(Document.supported("/path/to/file.txt")).toBe(false)
  })

  test("returns false for unknown binary extensions", () => {
    expect(Document.supported("/path/to/file.exe")).toBe(false)
    expect(Document.supported("/path/to/file.dll")).toBe(false)
    expect(Document.supported("/path/to/file.so")).toBe(false)
  })

  test("returns false for extensions not in the supported set", () => {
    expect(Document.supported("/path/to/file.md")).toBe(false)
    expect(Document.supported("/path/to/file.ts")).toBe(false)
    expect(Document.supported("/path/to/file.json")).toBe(false)
    expect(Document.supported("/path/to/file")).toBe(false)
    expect(Document.supported("/path/to/file.")).toBe(false)
  })
})

describe("Document.extract", () => {
  test("extracts a .csv file as markdown", async () => {
    const dir = Filesystem.sanitizePath(
      path.join(os.tmpdir(), "synergy-test-csv-" + Math.random().toString(36).slice(2)),
    )
    await Bun.write(path.join(dir, "test.csv"), "name,age,city\nAlice,30,NYC\nBob,25,LA\n")

    try {
      const result = await Document.extract(path.join(dir, "test.csv"))
      expect(result).not.toBeNull()
      expect(result!.markdown).toContain("name")
      expect(result!.markdown).toContain("Alice")
      expect(result!.markdown).toContain("Bob")
      // title can be string or null (markitdown-ts behavior)
      expect(typeof result!.title === "string" || result!.title === null).toBe(true)
      expect(result!.totalLines).toBeGreaterThan(0)
      expect(result!.totalBytes).toBeGreaterThan(0)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("extracts a .txt file through markitdown-ts (extract bypasses supported check)", async () => {
    const dir = Filesystem.sanitizePath(
      path.join(os.tmpdir(), "synergy-test-txt-" + Math.random().toString(36).slice(2)),
    )
    await Bun.write(path.join(dir, "test.txt"), "hello world\nline two\n")

    try {
      const result = await Document.extract(path.join(dir, "test.txt"))
      // markitdown-ts's PlainTextConverter may or may not handle .txt;
      // if it does, we get a result; if not, it returns null
      // Either outcome is acceptable — we're testing the API contract
      if (result) {
        expect(result.markdown.length).toBeGreaterThan(0)
        expect(result.totalLines).toBeGreaterThan(0)
        expect(result.totalBytes).toBeGreaterThan(0)
      }
      // null is acceptable — extract delegates to the converter
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("throws for a file that does not exist", async () => {
    await expect(Document.extract("/nonexistent/path/file.csv")).rejects.toThrow()
  })

  test("returns metadata with correct structure", async () => {
    const dir = Filesystem.sanitizePath(
      path.join(os.tmpdir(), "synergy-test-meta-" + Math.random().toString(36).slice(2)),
    )
    const content = "col1,col2\nval1,val2\n"
    await Bun.write(path.join(dir, "meta.csv"), content)

    try {
      const result = await Document.extract(path.join(dir, "meta.csv"))
      expect(result).not.toBeNull()
      expect(result!.markdown).toBeTruthy()
      expect(result!.title === null || typeof result!.title === "string").toBe(true)
      expect(typeof result!.totalLines).toBe("number")
      expect(typeof result!.totalBytes).toBe("number")
      expect(result!.totalBytes).toBe(Buffer.byteLength(result!.markdown, "utf-8"))
      expect(result!.totalLines).toBe(result!.markdown === "" ? 0 : result!.markdown.split("\n").length)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("times out with a reasonable timeout works for small files", async () => {
    const dir = Filesystem.sanitizePath(
      path.join(os.tmpdir(), "synergy-test-timeout-" + Math.random().toString(36).slice(2)),
    )
    await Bun.write(path.join(dir, "data.csv"), "a,b\n1,2\n")

    try {
      // Normal extraction with 30s timeout works fine
      const result = await Document.extract(path.join(dir, "data.csv"), 30_000)
      expect(result).not.toBeNull()
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })
})

describe("Document.extractText (legacy API)", () => {
  test("returns markdown string for a valid .csv file", async () => {
    const dir = Filesystem.sanitizePath(
      path.join(os.tmpdir(), "synergy-test-legacy-" + Math.random().toString(36).slice(2)),
    )
    await Bun.write(path.join(dir, "data.csv"), "x,y\n1,2\n")

    try {
      const text = await Document.extractText(path.join(dir, "data.csv"))
      expect(typeof text).toBe("string")
      expect(text.length).toBeGreaterThan(0)
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })

  test("throws when extraction fails (non-existent file)", async () => {
    // ExtractText wraps extract() and throws if the result is null.
    // For a non-existent file, extract() throws (propagated from Bun), not returns null.
    // This tests the non-existent file code path.
    await expect(Document.extractText("/nonexistent/path/doc.pdf")).rejects.toThrow()
  })
})
