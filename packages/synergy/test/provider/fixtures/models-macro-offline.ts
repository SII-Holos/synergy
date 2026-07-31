import { data } from "../../../src/provider/models-macro"

const action = process.argv[2]

let requests = 0
globalThis.fetch = (() => {
  requests++
  if (action === "body-error") {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("truncated body"))
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }
  return Promise.reject(new Error("models.dev fetch is disabled"))
}) as unknown as typeof fetch

const catalog = JSON.parse(await data())
process.stdout.write(JSON.stringify({ requests, providerIDs: Object.keys(catalog) }))
