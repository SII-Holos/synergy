const endpoint = process.env.BENCH_GATEWAY_BASE
const relay = process.env.BENCH_CAPTURE_ENDPOINT
if (!endpoint || !relay) {
  throw new Error("Session capture requires the isolated transport observer and gateway")
}
const bypass = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",")
process.env.NO_PROXY = bypass
process.env.no_proxy = bypass
const original = globalThis.fetch
globalThis.fetch = Object.assign(
  (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith(endpoint + "/")) return original(input, init)
    const request = new Request(input, init)
    return original(new Request(relay + url.slice(endpoint.length), request))
  },
  { preconnect: original.preconnect },
)
