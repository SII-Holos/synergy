globalThis.fetch = (async () =>
  Response.json(JSON.parse(process.env.MODELS_REFRESH_PAYLOAD ?? "{}"))) as unknown as typeof fetch
const { main } = await import("../../../src/index")
await main()
export {}
