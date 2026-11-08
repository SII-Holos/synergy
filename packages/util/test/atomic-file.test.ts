import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("the portable atomic writer promotes ordinary and durable private files under Node", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-atomic-file-node-"))
  try {
    const output = path.join(root, "atomic-file.mjs")
    const bundle = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../src/atomic-file.ts", import.meta.url))],
      target: "node",
    })
    expect(bundle.success).toBe(true)
    await fs.writeFile(output, await bundle.outputs[0]!.text())
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        `
      import { AtomicFile } from ${JSON.stringify(pathToFileURL(output).href)};
      import fs from 'node:fs/promises';
      const root = process.argv[1];
      await AtomicFile.writeJsonAtomic(root + '/ordinary.json', JSON.stringify({value: 1}));
      await AtomicFile.writeFileAtomic(root + '/nested/private.bin', new Uint8Array([4, 5, 6]), {private: true, durable: true});
      await Promise.all(Array.from({length: 8}, (_, value) => AtomicFile.writeJsonAtomic(root + '/ordinary.json', JSON.stringify({value}))));
      const result = JSON.parse(await fs.readFile(root + '/ordinary.json', 'utf8'));
      if (!Number.isInteger(result.value)) throw new Error('Invalid promoted document');
    `,
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    expect([...(await fs.readFile(path.join(root, "nested/private.bin")))]).toEqual([4, 5, 6])
    if (process.platform !== "win32")
      expect((await fs.stat(path.join(root, "nested/private.bin"))).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
