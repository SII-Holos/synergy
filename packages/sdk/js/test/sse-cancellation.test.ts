import { expect, test } from "bun:test"
import path from "node:path"

test("SSE abort observes a rejected reader cancellation without an unhandled rejection", async () => {
  const source = `
    import { createSseClient } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/gen/core/serverSentEvents.gen.ts"))};
    const abort = new AbortController();
    const server = Bun.serve({port:0,fetch:()=>new Response(new ReadableStream({
        start(c){c.enqueue(new TextEncoder().encode('data: {"ok":true}\\n\\n'))},
      }),{headers:{'content-type':'text/event-stream'}})});
    const { stream } = createSseClient({url:server.url.toString(),signal:abort.signal});
    const first = await stream.next();
    if(first.value?.ok!==true) throw new Error('event missing');
    const pending = stream.next(); await Bun.sleep(5); abort.abort(); await pending; await Bun.sleep(20);
    await server.stop(true);
    console.log('cancelled');
  `
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "cancelled\n", stderr: "" })
})
