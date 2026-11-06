import { installCapture } from "./capture.mjs"

export function startSessionCapture({ root, endpoint }) {
  const restore = installCapture({ root, endpoint })
  const active = new Map()
  let closing
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Task/cleanup clocks own cancellation; Bun's default 10s idle timer resets quiet model streams.
    // https://bun.com/docs/runtime/http/server
    idleTimeout: 0,
    maxRequestBodySize: 128 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url)
      if (!["/chat/completions", "/responses"].includes(url.pathname)) return new Response(null, { status: 404 })
      const controller = new AbortController()
      const done = Promise.withResolvers()
      active.set(controller, done.promise)
      const finish = () => {
        active.delete(controller)
        done.resolve()
      }
      try {
        const requestHeaders = new Headers(request.headers)
        for (const name of ["host", "content-length", "connection"]) requestHeaders.delete(name)
        const response = await fetch(endpoint + url.pathname, {
          method: request.method,
          headers: requestHeaders,
          body: await request.arrayBuffer(),
          signal: controller.signal,
        })
        const headers = new Headers(response.headers)
        for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"])
          headers.delete(name)
        if (!response.body) {
          finish()
          return new Response(null, { status: response.status, headers })
        }
        // The release calls process.exit while auxiliary responses are still arriving.
        // Keep only transport recording alive under the independent cleanup deadline.
        const [recording, delivery] = response.body.tee()
        void recording
          .pipeTo(new WritableStream({ write() {} }))
          .catch(() => {})
          .finally(finish)
        return new Response(delivery, { status: response.status, headers })
      } catch {
        finish()
        return new Response(null, { status: 502 })
      }
    },
  })
  return {
    url: server.url.toString().replace(/\/$/, ""),
    close(seconds, cancelled = false) {
      if (cancelled) {
        for (const controller of active.keys()) controller.abort()
        server.stop(true)
      }
      return (closing ??= (async () => {
        const started = Date.now()
        let timedOut = false
        const stopped = server.stop(false)
        const timer = setTimeout(() => {
          timedOut = true
          for (const controller of active.keys()) controller.abort()
          server.stop(true)
        }, seconds * 1000)
        try {
          await Promise.allSettled([...active.values()])
          server.stop(true)
          await stopped
          return { timed_out: timedOut, wall_ms: Date.now() - started }
        } finally {
          clearTimeout(timer)
          restore()
        }
      })())
    },
  }
}
