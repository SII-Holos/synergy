import fs from "node:fs/promises"
import path from "node:path"
import type { SandboxRuntimeTarget } from "./build/sandbox-assets"
import {
  EMBEDDING_RUNTIME_MODULE,
  EMBEDDING_RUNTIME_PATH,
  EMBEDDING_RUNTIME_WASM,
} from "../../../packages/library/src/vector/embedding-runtime"

export async function pruneSeedPayload(directory: string, target?: SandboxRuntimeTarget): Promise<void> {
  const modules = path.join(directory, "node_modules")
  const library = path.join(modules, "@ericsanchezok/synergy-library/dist")
  for (const relative of [
    "vector/packaged-embedding.js",
    `${EMBEDDING_RUNTIME_PATH}/${EMBEDDING_RUNTIME_MODULE}`,
    `${EMBEDDING_RUNTIME_PATH}/${EMBEDDING_RUNTIME_WASM}`,
  ])
    if (!(await Bun.file(path.join(library, relative)).exists()))
      throw new Error(`Cannot prune a seed without its bundled embedding asset: ${relative}`)

  if (target?.os === "linux") {
    const libc = target.abi ?? "glibc"
    const incompatible: string[] = []
    for (const pattern of ["**/node_modules/*/package.json", "**/node_modules/@*/*/package.json"])
      for await (const manifest of new Bun.Glob(pattern).scan(directory)) {
        const filename = path.join(directory, manifest)
        const pkg = (await Bun.file(filename).json()) as { libc?: string | string[] }
        const values = typeof pkg.libc === "string" ? [pkg.libc] : (pkg.libc ?? [])
        const allowed = values.filter((value) => !value.startsWith("!"))
        if (values.includes(`!${libc}`) || (allowed.length && !allowed.includes(libc) && !allowed.includes("*")))
          incompatible.push(path.dirname(filename))
      }
    for (const dependency of incompatible) await fs.rm(dependency, { recursive: true, force: true })
  }

  const unused: string[] = []
  for await (const relative of new Bun.Glob("**/*").scan({ cwd: modules, dot: true })) {
    const normalized = relative.split(path.sep).join("/")
    if (
      path.basename(normalized) === ".npmignore" ||
      /\.(?:[cm]?js|[cm]?ts)\.map$/.test(normalized) ||
      /(?:^|\/node_modules\/)onnxruntime-node\/bin\/.*\.(?:node|dll|dylib|pdb|lib|so(?:\.\d+)*)$/.test(normalized) ||
      /(?:^|\/node_modules\/)onnxruntime-web\/dist\/[^/]+\.wasm$/.test(normalized)
    )
      unused.push(path.join(modules, relative))
  }
  for (const file of unused) await fs.rm(file)
}
