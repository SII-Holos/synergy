import { describe, expect, test } from "bun:test"
import { buildWorkspaceFileBrowserUrl, buildWorkspaceFilePreviewUrl } from "../../src/utils/workspace-file-url"

const home = { scopeID: "home", workspaceID: "wsp_local", workspaceGeneration: 3 }
const project = { ...home, scopeID: "project" }

describe("workspace file preview URL", () => {
  test("uses the app origin for a cross-origin SDK while retaining the Workspace", () => {
    expect(buildWorkspaceFilePreviewUrl("http://127.0.0.1:4096", "http://localhost:3000", "docs/page.html", home)).toBe(
      "http://localhost:3000/workspace/files/raw/home/wsp_local/3/docs/page.html",
    )
  })
  test("keeps a same-origin reverse-proxy prefix and the file content version", () => {
    expect(
      buildWorkspaceFilePreviewUrl("https://example.test/proxy/4096", "https://example.test", "index.html", project, {
        mtime: 12,
        size: 128,
      }),
    ).toBe("https://example.test/proxy/4096/workspace/files/raw/cHJvamVjdA/wsp_local/3/index.html?v=12-128")
  })
})

describe("workspace file browser URL", () => {
  test("encodes each filename segment and preserves the selected generation for relative resources", () => {
    const url = buildWorkspaceFileBrowserUrl("https://example.test/prefix/", "my dir/你好 ?#%.html", project)
    expect(url).toBe(
      "https://example.test/prefix/workspace/files/raw/cHJvamVjdA/wsp_local/3/my%20dir/%E4%BD%A0%E5%A5%BD%20%3F%23%25.html",
    )
    expect(new URL("image.png", url).pathname).toBe(
      "/prefix/workspace/files/raw/cHJvamVjdA/wsp_local/3/my%20dir/image.png",
    )
  })
  test("requires a Workspace reference and distinguishes a rebind from an old preview", () => {
    expect(() => buildWorkspaceFileBrowserUrl("http://localhost", "file.html")).toThrow("Workspace")
    const first = buildWorkspaceFileBrowserUrl("http://localhost", "file.html", project)
    const rebound = buildWorkspaceFileBrowserUrl("http://localhost", "file.html", {
      ...project,
      workspaceGeneration: 4,
    })
    expect(first).not.toBe(rebound)
    expect(first).toContain("/wsp_local/3/")
  })
})
