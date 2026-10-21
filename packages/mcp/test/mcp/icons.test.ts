import { expect, test } from "bun:test"
import { resolveMcpIcons } from "../../src/icons"

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>`
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`

test("preserves safe themed MCP icons as bounded image data", async () => {
  expect(await resolveMcpIcons([{ src, theme: "dark", sizes: ["any"] }])).toEqual([
    { src, mimeType: "image/svg+xml", theme: "dark", sizes: ["any"] },
  ])
})

test("rejects active content, invalid image bytes and unsupported URLs", async () => {
  const script = `data:image/svg+xml;base64,${Buffer.from(svg.replace("</svg>", "<script>alert(1)</script></svg>")).toString("base64")}`
  expect(
    await resolveMcpIcons(
      [
        { src: script },
        { src: "file:///tmp/icon.svg" },
        { src: "javascript:alert(1)" },
        { src: "data:image/png;base64,aGVsbG8=" },
        { src: "https://third-party.invalid/icon.png" },
      ],
      "https://service.invalid/mcp",
    ),
  ).toEqual([])
})

test("fetches only same-origin HTTPS icons without credentials or redirects", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return new Response(svg, { headers: { "content-type": "image/svg+xml" } })
  }
  const icons = await resolveMcpIcons(
    [{ src: "https://service.invalid/icon.svg" }],
    "https://service.invalid/mcp",
    fetcher,
  )
  expect(icons[0]?.src).toBe(src)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.init).toMatchObject({ credentials: "omit", redirect: "error" })
  expect(
    await resolveMcpIcons([{ src: "https://other.invalid/icon.svg" }], "https://service.invalid/mcp", fetcher),
  ).toEqual([])
  expect(requests).toHaveLength(1)
})

test("failed, oversized and redirected icon responses leave the tool usable", async () => {
  for (const response of [
    new Response("", { status: 302 }),
    new Response(svg, { headers: { "content-length": "9999999" } }),
    new Response("x".repeat(70_000)),
  ]) {
    expect(
      await resolveMcpIcons(
        [{ src: "https://service.invalid/icon.svg" }],
        "https://service.invalid/mcp",
        async () => response,
      ),
    ).toEqual([])
  }
  expect(
    await resolveMcpIcons([{ src: "https://service.invalid/icon.svg" }], "https://service.invalid/mcp", async () => {
      throw new Error("offline")
    }),
  ).toEqual([])
})
