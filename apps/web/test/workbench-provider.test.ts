import { expect, test } from "bun:test"

test("workbench long replies survive an appended runtime reminder", async () => {
  const fixture = new URL("./fixtures/workbench/provider.ts", import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      import { startWorkbenchProvider } from ${JSON.stringify(fixture)}
      const { server, journal } = startWorkbenchProvider()
      try {
        const response = await fetch(new URL("/v1/chat/completions", server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "fixture-chat",
            messages: [
              { role: "user", content: "[long] Check reading while streaming" },
              { role: "user", content: "Runtime reminder" },
            ],
          }),
        })
        console.log(JSON.stringify({ body: await response.json(), journal }))
      } finally {
        await server.stop(true)
      }
    `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(error).toBe("")
  expect(code).toBe(0)
  expect(output).toContain("第 35 节")
  expect(JSON.parse(output).journal).toEqual([{ kind: "chat", streamed: false, chunks: 0 }])
})
