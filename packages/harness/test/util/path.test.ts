import { describe, expect, test } from "bun:test"
import { getFilename, getDirectory, getFileExtension, resolvePathInput } from "@ericsanchezok/synergy-util/path"

// ---------------------------------------------------------------------------
// getFilename — existing function (should pass immediately)
// ---------------------------------------------------------------------------
describe("getFilename", () => {
  test("returns filename from Unix absolute path", () => {
    expect(getFilename("/home/user/projects/myapp")).toBe("myapp")
  })

  test("returns filename from Unix path with trailing slash", () => {
    expect(getFilename("/home/user/")).toBe("user")
  })

  test("returns filename from Windows path with backslashes", () => {
    expect(getFilename("C:\\Users\\name\\projects")).toBe("projects")
  })

  test("returns filename from Windows path with trailing backslash", () => {
    expect(getFilename("C:\\Users\\name\\")).toBe("name")
  })

  test("returns filename from mixed-separator path", () => {
    expect(getFilename("C:/Users/mixed\\separators\\file.txt")).toBe("file.txt")
  })

  test("returns tilde-expansion path filename", () => {
    expect(getFilename("~/projects/myapp")).toBe("myapp")
  })

  test("returns empty string for empty input", () => {
    expect(getFilename("")).toBe("")
  })

  test("returns empty string for undefined", () => {
    expect(getFilename(undefined)).toBe("")
  })

  test("handles bare tilde", () => {
    expect(getFilename("~")).toBe("~")
  })

  test("handles bare root", () => {
    expect(getFilename("/")).toBe("")
  })

  test("handles UNC path", () => {
    expect(getFilename("//server/share/dir/file.txt")).toBe("file.txt")
  })
})

// ---------------------------------------------------------------------------
// getFileExtension — existing function (should pass immediately)
// ---------------------------------------------------------------------------
describe("getFileExtension", () => {
  test("returns extension from simple filename", () => {
    expect(getFileExtension("/home/user/file.txt")).toBe("txt")
  })

  test("returns last extension for double-extension files", () => {
    expect(getFileExtension("/home/user/archive.tar.gz")).toBe("gz")
  })

  test("returns filename when there is no extension", () => {
    expect(getFileExtension("/home/user/file")).toBe("/home/user/file")
  })

  test("returns empty string for empty input", () => {
    expect(getFileExtension("")).toBe("")
  })

  test("returns empty string for undefined", () => {
    expect(getFileExtension(undefined)).toBe("")
  })

  test("handles Windows path with backslashes", () => {
    expect(getFileExtension("C:\\Users\\name\\document.docx")).toBe("docx")
  })

  test("handles hidden dotfile prefix", () => {
    expect(getFileExtension("/home/user/.gitignore")).toBe("gitignore")
  })
})

// ---------------------------------------------------------------------------
// getDirectory — bug fix: must normalize backslashes on Windows
// ---------------------------------------------------------------------------
describe("getDirectory", () => {
  test("strips last segment from Unix path", () => {
    expect(getDirectory("/home/user/projects")).toBe("/home/user/")
  })

  test("preserves trailing slash on directory path", () => {
    expect(getDirectory("/home/user/")).toBe("/home/user/")
  })

  test("returns empty string for bare tilde (no parent)", () => {
    expect(getDirectory("~")).toBe("")
  })

  test("normalizes Windows backslash path", () => {
    expect(getDirectory("C:\\Users\\name\\projects")).toBe("C:/Users/name/")
  })

  test("normalizes Windows backslash path with trailing slash", () => {
    expect(getDirectory("C:\\Users\\name\\")).toBe("C:/Users/name/")
  })

  test("returns empty string for empty input", () => {
    expect(getDirectory("")).toBe("")
  })

  test("returns empty string for undefined", () => {
    expect(getDirectory(undefined)).toBe("")
  })

  test("handles root path", () => {
    expect(getDirectory("/")).toBe("/")
  })

  test("handles single-segment path", () => {
    expect(getDirectory("/projects")).toBe("/")
  })
})

// ---------------------------------------------------------------------------
// resolvePathInput — parses user-typed paths into parent + query
// ---------------------------------------------------------------------------
describe("resolvePathInput", () => {
  const homeDir = "/home/user"

  test("empty string falls back to homeDir", () => {
    expect(resolvePathInput("", homeDir)).toEqual({ path: "/home/user", query: "" })
  })

  test("tilde path expands and splits parent + query", () => {
    expect(resolvePathInput("~/projects/myapp", homeDir)).toEqual({
      path: "/home/user/projects",
      query: "myapp",
    })
  })

  test("bare tilde expands to homeDir with no query", () => {
    expect(resolvePathInput("~", homeDir)).toEqual({ path: "/home/user", query: "" })
  })

  test("Unix absolute path splits into parent and query", () => {
    expect(resolvePathInput("/home/user/projects", homeDir)).toEqual({
      path: "/home/user",
      query: "projects",
    })
  })

  test("Unix absolute path under /opt splits correctly", () => {
    expect(resolvePathInput("/opt/data", homeDir)).toEqual({ path: "/opt", query: "data" })
  })

  test("Windows backslash path normalizes and splits", () => {
    expect(resolvePathInput("C:\\Users\\name\\projects", homeDir)).toEqual({
      path: "C:/Users/name",
      query: "projects",
    })
  })

  test("Windows drive letter with single level keeps drive root as parent", () => {
    expect(resolvePathInput("D:\\data", homeDir)).toEqual({ path: "D:/", query: "data" })
    expect(resolvePathInput("D:/data", homeDir)).toEqual({ path: "D:/", query: "data" })
  })

  test("Windows drive root inputs resolve to drive root", () => {
    expect(resolvePathInput("D:\\", homeDir)).toEqual({ path: "D:/", query: "" })
    expect(resolvePathInput("D:/", homeDir)).toEqual({ path: "D:/", query: "" })
    expect(resolvePathInput("D:", homeDir)).toEqual({ path: "D:/", query: "" })
  })

  test("Windows nested drive path normalizes and splits", () => {
    expect(resolvePathInput("D:\\work\\repo", homeDir)).toEqual({ path: "D:/work", query: "repo" })
  })

  test("Windows path with two segments", () => {
    expect(resolvePathInput("C:\\Users\\me", homeDir)).toEqual({ path: "C:/Users", query: "me" })
  })

  test("UNC path splits at last component", () => {
    expect(resolvePathInput("//server/share/dir", homeDir)).toEqual({
      path: "//server/share",
      query: "dir",
    })
  })

  test("mixed forward and backslashes normalizes", () => {
    expect(resolvePathInput("C:/Users/mixed\\separators", homeDir)).toEqual({
      path: "C:/Users/mixed",
      query: "separators",
    })
    expect(resolvePathInput("C:/Users\\Tel13/proj", homeDir)).toEqual({
      path: "C:/Users/Tel13",
      query: "proj",
    })
  })

  test("backslash UNC path splits at last component", () => {
    expect(resolvePathInput("\\\\server\\share\\dir", homeDir)).toEqual({
      path: "//server/share",
      query: "dir",
    })
  })

  test("relative path uses homeDir as parent", () => {
    expect(resolvePathInput("myproject", homeDir)).toEqual({ path: "/home/user", query: "myproject" })
  })

  test("root path has no query", () => {
    expect(resolvePathInput("/", homeDir)).toEqual({ path: "/", query: "" })
  })

  test("single segment under root", () => {
    expect(resolvePathInput("/projects", homeDir)).toEqual({ path: "/", query: "projects" })
  })
})
