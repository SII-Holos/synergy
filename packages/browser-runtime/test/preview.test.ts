import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { connect } from "node:net"
import { BrowserPreview } from "../src/preview"
import type { BrowserPreviewUnavailable } from "../src/preview-types"
import { htmlPreview, previewFixture } from "./support/preview"

describe("anonymous public Browser preview", () => {
  test("reads title and description through a pinned socket without fetching page resources", async () => {
    await using fixture = previewFixture(
      () =>
        new Response(
          '<head><title>Read &amp; write &#65;</title><meta property="og:description" content="Public &quot;metadata&quot;"><link rel="icon" href="/favicon.ico"><meta property="og:image" content="/private.png"></head><body><img src="/image"><script src="/script"></script></body>',
          { headers: { "content-type": "text/html" } },
        ),
    )
    const result = await BrowserPreview.read(
      { url: "https://docs.example.org/guide?document=fixture-private#section" },
      fixture.options,
    )

    expect(result).toEqual({
      source: "docs.example.org",
      path: "/guide#section",
      title: "Read & write A",
      description: 'Public "metadata"',
    })
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].url).toBe("https://docs.example.org/guide?document=fixture-private")
    expect(fixture.connections[0]).toMatchObject({ address: "93.184.215.14", family: 4, port: 443 })
    expect(fixture.resolutions).toEqual(["docs.example.org"])
    for (const header of ["authorization", "cookie", "referer", "proxy-authorization", "x-github-token"]) {
      expect(fixture.requests[0].headers.has(header)).toBe(false)
    }
    expect(JSON.stringify(result)).not.toContain("fixture-private")
  })

  test("does not coalesce different queries or persist a second content cache", async () => {
    await using fixture = previewFixture((request) => htmlPreview(new URL(request.url).searchParams.get("document")!))
    expect(
      (await BrowserPreview.read({ url: "http://docs.example.org/page?document=first" }, fixture.options)).title,
    ).toBe("first")
    expect(
      (await BrowserPreview.read({ url: "http://docs.example.org/page?document=second" }, fixture.options)).title,
    ).toBe("second")
    expect(fixture.requests).toHaveLength(2)
  })

  test("validates TLS against the original hostname and rejects mismatched or untrusted certificates before HTTP", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    const valid = await BrowserPreview.read({ url: "https://docs.example.org/document" }, fixture.options)
    expect(valid.unavailable).toBeUndefined()
    expect(fixture.connections[0]).toMatchObject({ servername: "docs.example.org", tls: true })
    const mismatch = await BrowserPreview.read({ url: "https://unrelated.example.net/document" }, fixture.options)
    expect(mismatch.unavailable).toBe("network_error")
    const untrusted = await BrowserPreview.read(
      { url: "https://docs.example.org/document" },
      { ...fixture.options, certificateAuthority: undefined },
    )
    expect(untrusted.unavailable).toBe("network_error")
    expect(fixture.requests).toHaveLength(1)
  })

  test("ignores body lookalike metadata and decodes entities only once", async () => {
    await using fixture = previewFixture(
      () =>
        new Response(
          '<head><title>Literal &amp;lt;code&amp;gt;</title></head><body><title>Wrong title</title><meta name="description" content="Wrong summary"></body>',
          { headers: { "content-type": "text/html" } },
        ),
    )
    const result = await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)
    expect(result.title).toBe("Literal &lt;code&gt;")
    expect(result.description).toBeUndefined()
  })

  test("rejects userinfo and unsupported schemes without DNS or an HTTP request", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    for (const url of [
      "http://fixture-user:fixture-password@docs.example.org/page",
      "https://fixture-user@docs.example.org/page",
      "file:///etc/passwd",
      "ftp://docs.example.org/file",
      "not a URL",
    ]) {
      const result = await BrowserPreview.read({ url }, fixture.options)
      expect(result.unavailable).toBe("invalid_url")
      expect(JSON.stringify(result)).not.toMatch(/fixture-user|fixture-password/)
    }
    expect(fixture.connections).toHaveLength(0)
    expect(fixture.resolutions).toHaveLength(0)
    expect(fixture.requests).toHaveLength(0)
  })

  test("never sends credential-like URL query values or follows a token-bearing redirect", async () => {
    await using fixture = previewFixture(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://docs.example.org/page?access_token=fixture-private" },
        }),
    )
    for (const name of ["token", "access_token", "api_key", "apiKey", "authorization", "password", "X-Amz-Signature"]) {
      const result = await BrowserPreview.read(
        { url: `http://public.example.org/document?${name}=fixture-private` },
        fixture.options,
      )
      expect(result.unavailable).toBe("authentication_required")
      expect(JSON.stringify(result)).not.toContain("fixture-private")
    }
    expect(fixture.resolutions).toHaveLength(0)
    expect(fixture.connections).toHaveLength(0)
    expect(fixture.requests).toHaveLength(0)
    const redirected = await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)
    expect(redirected.unavailable).toBe("authentication_required")
    expect(fixture.requests).toHaveLength(1)
  })

  test("blocks special IPv4, IPv6 and local hostname forms before any connection", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    const hosts = [
      "localhost",
      "LOCALHOST.",
      "child.localhost",
      "printer.local",
      "intranet",
      "0.0.0.0",
      "0",
      "127.0.0.1",
      "127.255.255.254",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "100.127.255.255",
      "169.254.169.254",
      "168.63.129.16",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "[::]",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[::ffff:93.184.215.14]",
      "[::127.0.0.1]",
      "[fc00::1]",
      "[fdff::1]",
      "[fe80::1]",
      "[ff02::1]",
      "[64:ff9b::7f00:1]",
      "[64:ff9b:1::a00:1]",
      "[100::1]",
      "[2001:db8::1]",
      "[2001:2::1]",
      "[2002:7f00:1::]",
      "[3fff::1]",
    ]
    for (const host of hosts) {
      expect(
        (await BrowserPreview.read({ url: `http://${host}:${fixture.port}/secret` }, fixture.options)).unavailable,
      ).toBe("blocked_address")
    }
    expect(fixture.resolutions).toHaveLength(0)
    expect(fixture.connections).toHaveLength(0)
    expect(fixture.requests).toHaveLength(0)
  })

  test("validates every DNS candidate including mixed-family and malformed answers", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    for (const candidate of [
      { address: "127.0.0.1", family: 4 },
      { address: "10.1.2.3", family: 4 },
      { address: "::ffff:7f00:1", family: 6 },
      { address: "fe80::1", family: 6 },
      { address: "2001:db8::1", family: 6 },
      { address: "93.184.215.14", family: 6 },
      { address: "not-an-address", family: 4 },
    ] as const) {
      const result = await BrowserPreview.read(
        { url: "http://public.example.org/document" },
        {
          ...fixture.options,
          lookup: async () => [{ address: "93.184.215.14", family: 4 }, candidate],
        },
      )
      expect(result.unavailable).toBe("blocked_address")
    }
    expect(fixture.connections).toHaveLength(0)
    expect(fixture.requests).toHaveLength(0)
  })

  test("uses the validated DNS snapshot and does not perform another hostname lookup while connecting", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    let lookups = 0
    const result = await BrowserPreview.read(
      { url: "http://rebind.example.org/document" },
      {
        ...fixture.options,
        async lookup() {
          lookups++
          return [{ address: lookups === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 }]
        },
      },
    )
    expect(result.unavailable).toBeUndefined()
    expect(lookups).toBe(1)
    expect(fixture.connections.map((target) => target.address)).toEqual(["93.184.215.14"])
    expect(fixture.requests).toHaveLength(1)
  })

  test("accepts ordinary public IPv4 and IPv6 literals without resolving them again", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    for (const host of ["93.184.215.14", "[2606:4700:4700::1111]"]) {
      expect(
        (await BrowserPreview.read({ url: `http://${host}/document` }, fixture.options)).unavailable,
      ).toBeUndefined()
    }
    expect(fixture.resolutions).toHaveLength(0)
    expect(fixture.connections.map((target) => target.family)).toEqual([4, 6])
    expect(fixture.requests).toHaveLength(2)
  })

  test("mixed public DNS answers prefer IPv4 without trusting an unchecked alternative or resolving again", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    let lookups = 0
    const result = await BrowserPreview.read(
      { url: "http://dual-stack.example.org/document" },
      {
        ...fixture.options,
        async lookup() {
          lookups++
          return [
            { address: "2606:4700:4700::1111", family: 6 },
            { address: "93.184.215.14", family: 4 },
          ]
        },
        connect(target) {
          if (target.family === 6) throw new Error("IPv6 route is unavailable")
          return fixture.options.connect!(target)
        },
      },
    )
    expect(result.unavailable).toBeUndefined()
    expect(lookups).toBe(1)
    expect(fixture.connections.map((target) => target.address)).toEqual(["93.184.215.14"])
    expect(fixture.requests).toHaveLength(1)
  })

  test("revalidates each redirect and never requests a private or credential-bearing destination", async () => {
    let destination = ""
    await using fixture = previewFixture(() => Response.redirect(destination, 302))
    for (destination of [
      `http://127.0.0.1:${fixture.port}/private`,
      `http://[::ffff:7f00:1]:${fixture.port}/private`,
      "http://fixture-user:fixture-password@docs.example.org/private",
    ]) {
      const before = fixture.requests.length
      const result = await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)
      expect(result.unavailable).toBe(destination.includes("fixture-user") ? "invalid_url" : "blocked_address")
      expect(result.source).toBe("public.example.org")
      expect(result.path).toBe("/document")
      expect(fixture.requests.length - before).toBe(1)
      expect(JSON.stringify(result)).not.toMatch(/fixture-user|fixture-password/)
    }
  })

  test("re-resolves even a same-host redirect and blocks a rebound address before the second HTTP request", async () => {
    await using fixture = previewFixture(() => new Response(null, { status: 302, headers: { location: "/next" } }))
    let lookups = 0
    const result = await BrowserPreview.read(
      { url: "http://rebind.example.org/document" },
      {
        ...fixture.options,
        async lookup() {
          lookups++
          return [{ address: lookups === 1 ? "93.184.215.14" : "127.0.0.1", family: 4 }]
        },
      },
    )
    expect(result.unavailable).toBe("blocked_address")
    expect(lookups).toBe(2)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.connections).toHaveLength(1)
  })

  test("allows a public document redirect but keeps the original source and path, drops redirect cookies", async () => {
    await using fixture = previewFixture((request) =>
      new URL(request.url).pathname === "/document"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://canonical.example.org/moved", "set-cookie": "private=fixture-secret" },
          })
        : htmlPreview("Canonical document"),
    )
    const result = await BrowserPreview.read({ url: "http://original.example.org/document#part" }, fixture.options)
    expect(result).toMatchObject({
      title: "Canonical document",
      source: "original.example.org",
      path: "/document#part",
    })
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1].headers.has("cookie")).toBe(false)
    expect(fixture.resolutions).toEqual(["original.example.org", "canonical.example.org"])
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
  })

  test("stops redirect loops and finite chains", async () => {
    let loop = true
    await using fixture = previewFixture(
      (request) =>
        new Response(null, {
          status: 302,
          headers: { location: loop ? "/document#different-fragment" : `/next/${fixture.requests.length}` },
        }),
    )
    expect(
      (await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)).unavailable,
    ).toBe("redirect_loop")
    expect(fixture.requests).toHaveLength(1)
    loop = false
    expect(
      (await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)).unavailable,
    ).toBe("redirect_limit")
    expect(fixture.requests).toHaveLength(7)
  })

  test("does not use a login page or site homepage as a document preview", async () => {
    let location = "/login?returnTo=fixture-secret"
    await using fixture = previewFixture(() => new Response(null, { status: 302, headers: { location } }))
    for (location of ["/login?returnTo=fixture-secret", "/accounts/signin", "/"]) {
      const before = fixture.requests.length
      const result = await BrowserPreview.read({ url: "http://public.example.org/private-document" }, fixture.options)
      expect(result).toMatchObject({
        source: "public.example.org",
        title: "public.example.org",
        path: "/private-document",
        unavailable: location === "/" ? "target_changed" : "authentication_required",
      })
      expect(result.description).toBeUndefined()
      expect(fixture.requests.length - before).toBe(1)
      expect(JSON.stringify(result)).not.toContain("fixture-secret")
    }
  })

  test("returns typed unavailable for login, bot, error, binary and empty responses", async () => {
    let response: () => Response = () => htmlPreview()
    await using fixture = previewFixture(() => response())
    const cases: Array<[() => Response, BrowserPreviewUnavailable]> = [
      [() => new Response("private", { status: 401 }), "authentication_required"],
      [() => new Response("forbidden", { status: 403 }), "authentication_required"],
      [() => new Response("missing", { status: 404 }), "http_error"],
      [() => new Response("rate limit", { status: 429 }), "bot_challenge"],
      [() => htmlPreview("Sign in to Notion", "Private document text must not be returned"), "authentication_required"],
      [
        () =>
          new Response('<title>Document</title><input type="password">', { headers: { "content-type": "text/html" } }),
        "authentication_required",
      ],
      [() => htmlPreview("Just a moment...", "Verify you are human"), "bot_challenge"],
      [() => new Response("image", { headers: { "content-type": "image/png" } }), "non_text"],
      [
        () => new Response("plain text is not HTML metadata", { headers: { "content-type": "text/plain" } }),
        "non_text",
      ],
      [() => htmlPreview("", ""), "empty_metadata"],
      [
        () => new Response("not decoded", { headers: { "content-type": "text/html", "content-encoding": "gzip" } }),
        "unsupported_encoding",
      ],
    ]
    for (const [next, reason] of cases) {
      response = next
      const result = await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)
      expect(result.unavailable).toBe(reason)
      expect(result.description).toBeUndefined()
      expect(result.code).toBeUndefined()
      expect(result.title).toBe("public.example.org")
    }
  })

  test("enforces the 5MiB byte limit both with content-length and during a chunked response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "content-length": String(5 * 1024 * 1024 + 1) })
      response.end("small")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture must bind a TCP port")
    await using fixture = previewFixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`<title>${"中".repeat(2 * 1024 * 1024)}</title>`))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    )
    try {
      expect(
        (
          await BrowserPreview.read(
            { url: "http://public.example.org/document" },
            {
              ...fixture.options,
              connect: (target) => connect({ host: "127.0.0.1", port: address.port, signal: target.signal }),
            },
          )
        ).unavailable,
      ).toBe("too_large")
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
    }
    expect(
      (await BrowserPreview.read({ url: "http://public.example.org/document" }, fixture.options)).unavailable,
    ).toBe("too_large")
  })

  test("cancels an in-flight response and does not reuse its late metadata", async () => {
    let release!: () => void
    let started!: () => void
    const active = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await using fixture = previewFixture(async () => {
      started()
      await held
      return htmlPreview("Late private title")
    })
    const controller = new AbortController()
    const pending = BrowserPreview.read(
      { url: "http://public.example.org/document" },
      { ...fixture.options, signal: controller.signal },
    )
    await active
    controller.abort(new Error("fixture-private-abort"))
    const result = await pending
    release()
    expect(result.unavailable).toBe("cancelled")
    expect(JSON.stringify(result)).not.toMatch(/Late private|fixture-private-abort/)
  })

  test("cancels a streaming response after headers instead of waiting for body completion", async () => {
    let observed!: () => void
    const started = new Promise<void>((resolve) => {
      observed = resolve
    })
    await using fixture = previewFixture(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<head><title>Incomplete"))
            },
          }),
          { headers: { "content-type": "text/html" } },
        ),
    )
    const controller = new AbortController()
    const pending = BrowserPreview.read(
      { url: "http://public.example.org/document" },
      {
        ...fixture.options,
        signal: controller.signal,
        connect(target) {
          const socket = fixture.options.connect!(target)
          socket.once("data", observed)
          return socket
        },
      },
    )
    await started
    controller.abort()
    expect((await pending).unavailable).toBe("cancelled")
    expect(fixture.requests).toHaveLength(1)
  })

  test("times out response and DNS work, and a late DNS result cannot create a connection", async () => {
    let release!: () => void
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(htmlPreview("Too late"))
    })
    await using fixture = previewFixture(() => held)
    expect(
      (await BrowserPreview.read({ url: "http://public.example.org/document" }, { ...fixture.options, timeoutMs: 30 }))
        .unavailable,
    ).toBe("timeout")
    release()
    let resolveDNS!: (addresses: Array<{ address: string; family: 4 }>) => void
    const dns = new Promise<Array<{ address: string; family: 4 }>>((resolve) => {
      resolveDNS = resolve
    })
    const before = fixture.requests.length
    expect(
      (
        await BrowserPreview.read(
          { url: "http://slow-dns.example.org/document" },
          { ...fixture.options, timeoutMs: 30, lookup: () => dns },
        )
      ).unavailable,
    ).toBe("timeout")
    resolveDNS([{ address: "93.184.215.14", family: 4 }])
    await Bun.sleep(10)
    expect(fixture.requests).toHaveLength(before)
  })

  test("handles DNS and connection errors without returning raw credential-bearing exceptions", async () => {
    await using fixture = previewFixture(() => htmlPreview())
    for (const lookup of [
      async () => [],
      async () => {
        throw new Error("fixture-private-dns")
      },
    ]) {
      const result = await BrowserPreview.read(
        { url: "http://missing.example.org/document" },
        { ...fixture.options, lookup },
      )
      expect(result.unavailable).toBe("dns_failed")
      expect(JSON.stringify(result)).not.toContain("fixture-private-dns")
    }
    const result = await BrowserPreview.read(
      { url: "http://public.example.org/document" },
      {
        ...fixture.options,
        connect() {
          throw new Error("fixture-private-connect")
        },
      },
    )
    expect(result.unavailable).toBe("network_error")
    expect(JSON.stringify(result)).not.toContain("fixture-private-connect")
  })
})

describe("immutable GitHub source previews", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567"

  test("fetches an exact fixed commit and returns at most eight selected lines as an explicit excerpt", async () => {
    await using fixture = previewFixture(
      () =>
        new Response(Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join("\n"), {
          headers: { "content-type": "text/plain" },
        }),
    )
    const original = `https://github.com/org/repo/blob/${commit}/src/index.ts#L289-L327`
    const result = await BrowserPreview.read({ url: original }, fixture.options)
    expect(result).toMatchObject({
      title: "repo / index.ts",
      source: "github.com",
      path: `/org/repo/blob/${commit}/src/index.ts#L289-L327`,
      code: {
        text: Array.from({ length: 8 }, (_, index) => `line ${289 + index}`).join("\n"),
        language: "typescript",
        startLine: 289,
      },
    })
    expect(result.meta).toContain("Excerpt")
    expect(result.meta).toContain(commit)
    expect(result.meta).toContain("289–296")
    expect(result.meta).toContain("289–327")
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0].url).toBe(`https://raw.githubusercontent.com/org/repo/${commit}/src/index.ts`)
  })

  test("treats source directories named auth as code rather than a website login redirect", async () => {
    await using fixture = previewFixture(
      () => new Response("export const publicValue = true", { headers: { "content-type": "text/plain" } }),
    )
    const result = await BrowserPreview.read(
      { url: `https://github.com/org/repo/blob/${commit}/src/auth/index.ts#L1` },
      fixture.options,
    )
    expect(result.code?.text).toBe("export const publicValue = true")
    expect(fixture.requests).toHaveLength(1)
  })

  test("never substitutes a homepage, login or HTML response for immutable raw source", async () => {
    let redirected = true
    await using fixture = previewFixture(() =>
      redirected ? Response.redirect("https://github.com/", 302) : htmlPreview("Sign in to GitHub"),
    )
    const url = `https://github.com/org/repo/blob/${commit}/index.ts#L1`
    expect((await BrowserPreview.read({ url }, fixture.options)).unavailable).toBe("target_changed")
    redirected = false
    expect((await BrowserPreview.read({ url }, fixture.options)).unavailable).toBe("non_text")
    expect(fixture.requests).toHaveLength(2)
  })

  test("never guesses a slash-bearing ref split or treats a lookalike domain as GitHub", async () => {
    await using fixture = previewFixture(() => htmlPreview("Original webpage"))
    for (const url of [
      "https://github.com/org/repo/blob/feature/slash/src/index.ts#L4-L8",
      `http://github.com.attacker.example.org/org/repo/blob/${commit}/src/index.ts#L4-L8`,
      `https://github.com/org/repo/blob/${commit}/src%2Findex.ts#L4-L8`,
    ]) {
      const result = await BrowserPreview.read({ url }, fixture.options)
      expect(result.title).toBe("Original webpage")
      expect(result.code).toBeUndefined()
    }
    expect(fixture.requests.some((request) => new URL(request.url).hostname === "raw.githubusercontent.com")).toBe(
      false,
    )
  })

  test("rejects nonexistent or reversed ranges rather than substituting an unrelated source excerpt", async () => {
    await using fixture = previewFixture(
      () => new Response("one\ntwo\nthree", { headers: { "content-type": "text/plain" } }),
    )
    for (const fragment of ["#L5-L9", "#L3-L2", "#L0", "#L9007199254740992"]) {
      const result = await BrowserPreview.read(
        { url: `https://github.com/org/repo/blob/${commit}/index.ts${fragment}` },
        fixture.options,
      )
      expect(result.unavailable).toBe("invalid_range")
      expect(result.code).toBeUndefined()
    }
  })
})
