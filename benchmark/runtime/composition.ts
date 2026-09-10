import { BenchmarkInputError } from "./input-error"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { realpath } from "node:fs/promises"
import type { openLocalRuntime } from "@ericsanchezok/synergy-runtime-local"

export interface Composition {
  id: string
  register(): Promise<void>
  open: typeof openLocalRuntime
}

export async function loadComposition(name: string): Promise<Composition> {
  const builtin = {
    core: () => import("./compositions/core"),
    "core-library": () => import("./compositions/core-library"),
    full: () => import("./compositions/full"),
  }
  const loader = Object.hasOwn(builtin, name) ? builtin[name as keyof typeof builtin] : undefined
  const requested = !loader && name.startsWith("./") ? path.resolve(import.meta.dir, name) : undefined
  if (requested && !(await Bun.file(requested).exists()))
    throw new BenchmarkInputError(`Runtime composition file not found: ${name}`)
  const custom = requested ? await realpath(requested) : undefined
  if (custom && !custom.startsWith(import.meta.dir + path.sep))
    throw new BenchmarkInputError("Custom compositions must stay inside the frozen runtime directory")
  const module = loader ? await loader() : custom ? await import(pathToFileURL(custom).href) : undefined
  const value = module?.default as Composition | undefined
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.register !== "function" ||
    typeof value.open !== "function"
  )
    throw new BenchmarkInputError(`Invalid runtime composition: ${name}`)
  return value
}
