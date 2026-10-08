import { describe, expect, test } from "bun:test"
import { ResourceReference } from "../src/resource-reference"

const context: ResourceReference.Context = {
  state: "bound",
  workspace: { id: "wsp_original", generation: 3, root: "/work/project" },
  directory: "",
}

describe("resource references", () => {
  test("copied references preserve encoded filenames and their navigation location", () => {
    for (const input of [
      "src/中文%20%23%3F%25.ts#L2C3-L4C7",
      "asset://0123456789abcdef.pdf#page=2",
      "docs/guide.md#详情",
      "https://example.org/a#L2",
      "file://host/share/a.ts#L2",
      "file:///asset/local.png",
    ]) {
      const reference = ResourceReference.parse(input)
      expect(ResourceReference.parse(ResourceReference.format(reference))).toEqual(reference)
    }
    expect(
      ResourceReference.format({ kind: "workspace-file", path: "src/missing.ts", location: { kind: "text", line: 7 } }),
    ).toBe("src/missing.ts#L7")
  })
  test("validates column-only ranges on their implicit end line", () => {
    expect(ResourceReference.Location.safeParse({ kind: "text", line: 3, column: 8, endColumn: 2 }).success).toBe(false)
    expect(ResourceReference.Location.safeParse({ kind: "text", line: 3, column: 2, endColumn: 8 }).success).toBe(true)
    expect(
      ResourceReference.Location.safeParse({ kind: "text", line: 3, column: 8, endLine: 4, endColumn: 2 }).success,
    ).toBe(true)
  })
  test.each([
    [
      "packages/harness/src/agent/prompt/progress.ts#L3",
      "packages/harness/src/agent/prompt/progress.ts",
      { kind: "text", line: 3 },
    ],
    ["src/app.ts:42:6-45:9", "src/app.ts", { kind: "text", line: 42, column: 6, endLine: 45, endColumn: 9 }],
    ["src/app.ts#L42C6-L45C9", "src/app.ts", { kind: "text", line: 42, column: 6, endLine: 45, endColumn: 9 }],
    ["src/app.ts:3–7", "src/app.ts", { kind: "text", line: 3, endLine: 7 }],
    ["文档/图%20表%23一.md#标题", "文档/图 表#一.md", { kind: "heading", id: "标题" }],
    ["file:///work/project/a%3Fb.ts#L2", "/work/project/a?b.ts", { kind: "text", line: 2 }],
    ["C:\\work\\project\\src\\a.ts:2", "C:/work/project/src/a.ts", { kind: "text", line: 2 }],
  ] as const)("parses %s without losing path or location", (input, path, location) => {
    expect(ResourceReference.parse(input)).toEqual({ kind: "workspace-file", path, location })
  })

  test("keeps external links and immutable asset identity separate from location", () => {
    expect(ResourceReference.parse("https://example.org/a.ts#L3")).toEqual({
      kind: "url",
      url: "https://example.org/a.ts#L3",
    })
    expect(ResourceReference.parse("asset://0123456789abcdef.pdf#page=4")).toEqual({
      kind: "asset",
      url: "asset://0123456789abcdef.pdf",
      location: { kind: "page", page: 4 },
    })
    expect(ResourceReference.parse("#details")).toEqual({ kind: "anchor", id: "details" })
    expect(ResourceReference.parse("//example.org/image.png")).toEqual({
      kind: "url",
      url: "https://example.org/image.png",
    })
  })

  test.each([
    "javascript:alert(1)",
    "data:text/html,<script>",
    "asset://../secret",
    "src/a.ts:0",
    "src/a.ts#L9-L2",
    "src/a.ts#L99999999999999999",
    "bad%ZZ.ts",
    "src/a.ts?token=secret",
    "a\u0000b.ts",
  ])("rejects invalid target %s", (input) => {
    expect(ResourceReference.parse(input).kind).toBe("unavailable")
  })

  test("resolves against captured context, including document-relative parents", () => {
    expect(ResourceReference.resolvePath("src/a.ts", context)).toBe("src/a.ts")
    expect(ResourceReference.resolvePath("/work/project/src/a.ts", context)).toBe("src/a.ts")
    expect(ResourceReference.resolvePath("../src/a.ts", { ...context, directory: "docs" })).toBe("src/a.ts")
    expect(ResourceReference.resolvePath(".", context)).toBe("")
    for (const path of ["../../secret", "/work/other/a.ts", "~/a.ts"])
      expect(ResourceReference.resolvePath(path, context)).toBeUndefined()
    expect(ResourceReference.resolvePath("a.ts", { state: "unresolved" })).toBeUndefined()
    expect(ResourceReference.resolvePath("a.ts", { state: "none" })).toBeUndefined()
    expect(
      ResourceReference.resolvePath("/src/a.ts", { ...context, workspace: { ...context.workspace, root: "/" } }),
    ).toBe("src/a.ts")
  })

  test("retains encoded filename characters and Windows ownership", () => {
    for (const path of ["/a/文档 #?%.ts", "C:/a/文档 #?%.ts", "//host/share/a.ts"])
      expect(ResourceReference.parse(ResourceReference.fileUrl(path))).toEqual({ kind: "workspace-file", path })
    expect(ResourceReference.normalizePath("\\root\\file")).toBeUndefined()
    const parsed = ResourceReference.parse("percent%2520.ts")
    expect(parsed).toEqual({ kind: "workspace-file", path: "percent%20.ts" })
    expect(
      ResourceReference.resolvePath("c:/WORK/project/src/a.ts", {
        state: "bound",
        workspace: { id: "wsp_windows", generation: 1, root: "C:/work/project" },
        directory: "",
      }),
    ).toBe("src/a.ts")
    expect(ResourceReference.parse("file://host/share/a.ts#L1")).toEqual({
      kind: "workspace-file",
      path: "//host/share/a.ts",
      location: { kind: "text", line: 1 },
    })
  })
})
