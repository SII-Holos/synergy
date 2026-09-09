import { pathToFileURL } from "node:url"
import path from "node:path"
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
  const loader = builtin[name as keyof typeof builtin]
  const module = loader
    ? await loader()
    : name.startsWith("./")
      ? await import(pathToFileURL(path.resolve(import.meta.dir, name)).href)
      : undefined
  const value = module?.default as Composition | undefined
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.register !== "function" ||
    typeof value.open !== "function"
  )
    throw new Error(`Invalid runtime composition: ${name}`)
  return value
}
