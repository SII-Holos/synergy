import { connect } from "node:net"
import type { BrowserPreviewConnection, BrowserPreviewOptions } from "../../src/preview-network"

import { key, cert } from "./fixtures/tls"

export function previewFixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const connections: BrowserPreviewConnection[] = []
  const resolutions: string[] = []
  const serve = (tls: boolean) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(tls ? { tls: { key, cert } } : {}),
      fetch(request) {
        requests.push(request.clone())
        return handler(request)
      },
    })
  const server = serve(false)
  const tlsServer = serve(true)
  const options: BrowserPreviewOptions = {
    certificateAuthority: cert,
    async lookup(hostname) {
      resolutions.push(hostname)
      return [{ address: "93.184.215.14", family: 4 }]
    },
    connect(target) {
      connections.push(target)
      return connect({ host: "127.0.0.1", port: (target.tls ? tlsServer : server).port!, signal: target.signal })
    },
  }
  return {
    requests,
    connections,
    resolutions,
    options,
    port: server.port!,
    async [Symbol.asyncDispose]() {
      await Promise.all([server.stop(true), tlsServer.stop(true)])
    },
  }
}

export function htmlPreview(title = "Public document", description = "Anonymous public description") {
  return new Response(
    `<html><head><title>${title}</title><meta name="description" content="${description}"></head></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  )
}
