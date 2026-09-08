import { describe, expect, test } from "bun:test"
import { buildWorkspaceFileBrowserUrl, buildWorkspaceFilePreviewUrl } from "../../src/utils/workspace-file-url"

describe("workspace file preview URL", () => {
  test("uses the app origin when the SDK base is cross-origin (bun dev)", () => {
    expect(
      buildWorkspaceFilePreviewUrl("http://127.0.0.1:4096", "http://localhost:3000", "docs/page.html", {
        scopeID: "home",
      }),
    ).toBe("http://localhost:3000/workspace/files/raw/home/docs/page.html")
  })

  test("keeps the SDK base when it is same-origin with the app (reverse proxy)", () => {
    expect(
      buildWorkspaceFilePreviewUrl("https://example.test/proxy/4096", "https://example.test", "index.html", {
        scopeID: "home",
      }),
    ).toBe("https://example.test/proxy/4096/workspace/files/raw/home/index.html")
  })

  test("appends the version query when provided", () => {
    expect(
      buildWorkspaceFilePreviewUrl(
        "http://127.0.0.1:4096",
        "http://127.0.0.1:4096",
        "index.html",
        { directory: "/workspace/demo" },
        { mtime: 1725000000, size: 128 },
      ),
    ).toBe("http://127.0.0.1:4096/workspace/files/raw/L3dvcmtzcGFjZS9kZW1v/index.html?v=1725000000-128")
  })

  test("omits the version query when version is absent", () => {
    expect(
      buildWorkspaceFilePreviewUrl("http://127.0.0.1:4096", "http://127.0.0.1:4096", "index.html", {
        scopeID: "home",
      }),
    ).toBe("http://127.0.0.1:4096/workspace/files/raw/home/index.html")
  })
})

describe("workspace file browser URL", () => {
  test("builds a path-based raw URL against the server base", () => {
    expect(buildWorkspaceFileBrowserUrl("http://127.0.0.1:4096", "docs/page.html")).toBe(
      "http://127.0.0.1:4096/workspace/files/raw/home/docs/page.html",
    )
  })

  test("strips a trailing slash from the base URL", () => {
    expect(buildWorkspaceFileBrowserUrl("https://example.test/proxy/4096/", "index.htm")).toBe(
      "https://example.test/proxy/4096/workspace/files/raw/home/index.htm",
    )
  })

  test("encodes spaces and special characters per segment but keeps slashes", () => {
    expect(buildWorkspaceFileBrowserUrl("http://127.0.0.1:4096", "my dir/hello & world.html")).toBe(
      "http://127.0.0.1:4096/workspace/files/raw/home/my%20dir/hello%20%26%20world.html",
    )
  })

  test("encodes the scope directory as a base64url token", () => {
    expect(
      buildWorkspaceFileBrowserUrl("http://127.0.0.1:4096", "index.html", {
        directory: "/home/user/my project",
      }),
    ).toBe("http://127.0.0.1:4096/workspace/files/raw/L2hvbWUvdXNlci9teSBwcm9qZWN0/index.html")
  })

  test("uses the literal home token for the home scope", () => {
    expect(buildWorkspaceFileBrowserUrl("http://127.0.0.1:4096", "index.html", { scopeID: "home" })).toBe(
      "http://127.0.0.1:4096/workspace/files/raw/home/index.html",
    )
  })

  test("prefers scopeID home over a directory", () => {
    expect(
      buildWorkspaceFileBrowserUrl("http://127.0.0.1:4096", "index.html", {
        scopeID: "home",
        directory: "/home/user/x",
      }),
    ).toBe("http://127.0.0.1:4096/workspace/files/raw/home/index.html")
  })
})
