globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (process.env.MODELS_REFRESH_TEST_MODE === "network") throw new Error("Fixture network failure")
  if (process.env.MODELS_REFRESH_TEST_MODE === "http") return new Response("Unavailable", { status: 503 })
  if (process.env.MODELS_REFRESH_TEST_MODE === "invalid-json") return new Response("not JSON")
  if (process.env.MODELS_REFRESH_TEST_MODE === "body") {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Fixture body failure"))
        },
      }),
    )
  }
  if (process.env.MODELS_REFRESH_TEST_MODE === "mirror" && String(input) === "https://models.dev/api.json") {
    return new Response("Unavailable", { status: 503 })
  }
  return Response.json(JSON.parse(process.env.MODELS_REFRESH_PAYLOAD ?? "{}"))
}) as unknown as typeof fetch
await import("../../../src/main")
export {}
