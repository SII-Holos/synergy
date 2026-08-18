import { describe, expect, test } from "bun:test"
import { getDirectory, getFileExtension, getFilename, resolvePathInput } from "../src/path"

describe("getFilename", () => {
  test("extracts the last segment for forward and backslash paths", () => {
    expect(getFilename("/home/user/projects/app.ts")).toBe("app.ts")
    expect(getFilename("C:\\Users\\projects\\app.ts")).toBe("app.ts")
    expect(getFilename("src/components/button")).toBe("button")
  })

  test("handles trailing separators and empty input", () => {
    expect(getFilename("/home/user/")).toBe("user")
    expect(getFilename("/")).toBe("")
    expect(getFilename("")).toBe("")
    expect(getFilename(undefined)).toBe("")
  })
})

describe("getDirectory", () => {
  test("returns the parent directory with a trailing separator", () => {
    expect(getDirectory("/home/user/projects")).toBe("/home/user/")
    expect(getDirectory("C:\\Users\\projects")).toBe("C:/Users/")
    expect(getDirectory("src/feature/file.ts")).toBe("src/feature/")
  })

  test("handles roots and empty input", () => {
    expect(getDirectory("/")).toBe("/")
    expect(getDirectory("~")).toBe("")
    expect(getDirectory("")).toBe("")
    expect(getDirectory(undefined)).toBe("")
    expect(getDirectory("file.ts")).toBe("")
  })
})

describe("getFileExtension", () => {
  test("returns the last dot-segment", () => {
    expect(getFileExtension("app.test.ts")).toBe("ts")
    expect(getFileExtension("/home/user/archive.tar.gz")).toBe("gz")
    expect(getFileExtension("no-extension")).toBe("no-extension")
    expect(getFileExtension("")).toBe("")
    expect(getFileExtension(undefined)).toBe("")
  })
})

describe("resolvePathInput", () => {
  const homeDir = "/home/user"

  test("returns homeDir for empty input and bare tilde", () => {
    expect(resolvePathInput("", homeDir)).toEqual({ path: homeDir, query: "" })
    expect(resolvePathInput("   ", homeDir)).toEqual({ path: homeDir, query: "" })
    expect(resolvePathInput("~", homeDir)).toEqual({ path: homeDir, query: "" })
    expect(resolvePathInput("", "")).toEqual({ path: "/", query: "" })
  })

  test("expands tilde-prefixed paths", () => {
    expect(resolvePathInput("~/projects/myapp", homeDir)).toEqual({
      path: "/home/user/projects",
      query: "myapp",
    })
  })

  test("normalizes backslashes and splits absolute paths", () => {
    expect(resolvePathInput("C:\\Users\\me", homeDir)).toEqual({ path: "C:/Users", query: "me" })
    expect(resolvePathInput("D:\\data", homeDir)).toEqual({ path: "D:/", query: "data" })
    expect(resolvePathInput("D:", homeDir)).toEqual({ path: "D:/", query: "" })
    expect(resolvePathInput("/var/log/syslog", homeDir)).toEqual({ path: "/var/log", query: "syslog" })
  })

  test("treats relative input as a query within homeDir", () => {
    expect(resolvePathInput("myproject", homeDir)).toEqual({ path: homeDir, query: "myproject" })
  })
})
