import { expect, test } from "bun:test"

test("calendar day steps keep midnight across daylight-saving changes", async () => {
  const source = new URL("../../../src/components/agenda/date.ts", import.meta.url).pathname
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {addDays} from ${JSON.stringify(source)}; const start=new Date(2026,2,8); const end=new Date(addDays(start.getTime(),1)); console.log(JSON.stringify([end.getDate(),end.getHours(),(end.getTime()-start.getTime())/3600000]));`,
    ],
    { env: { ...process.env, TZ: "America/New_York" }, stdout: "pipe", stderr: "pipe" },
  )
  expect(await child.exited).toBe(0)
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual([9, 0, 23])
})
