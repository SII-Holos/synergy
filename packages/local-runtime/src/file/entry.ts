import path from "node:path"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { NativeFileEntry } from "./entry-core"

export namespace FileEntry {
  export const PartialError = NativeFileEntry.PartialError
  export const LimitError = NativeFileEntry.LimitError
  export type Validation = NativeFileEntry.Validation
  export type Entry = NativeFileEntry.Entry
  export const inspect = NativeFileEntry.inspect
  export const canonical = NativeFileEntry.canonical

  async function admitted<T extends NativeFileEntry.Options, R>(
    paths: string[],
    input: T,
    fn: (input: T) => Promise<R>,
  ): Promise<R> {
    const targets = await Promise.all(paths.map(canonical))
    return WorkspaceAccess.write(
      targets.map((target) => path.dirname(target)),
      () => {
        const signals = [input.signal, WorkspaceAccess.signal()].filter((signal): signal is AbortSignal => !!signal)
        return fn({ ...input, signal: signals.length ? AbortSignal.any(signals) : undefined })
      },
      input.signal,
    )
  }

  export function mkdir(input: Parameters<typeof NativeFileEntry.mkdir>[0]) {
    return admitted([input.path], input, NativeFileEntry.mkdir)
  }

  export function replace(input: Parameters<typeof NativeFileEntry.replace>[0]) {
    return admitted([input.path], input, NativeFileEntry.replace)
  }

  export function copy(input: Parameters<typeof NativeFileEntry.copy>[0]) {
    return admitted([input.from, input.to], input, NativeFileEntry.copy)
  }

  export function move(input: Parameters<typeof NativeFileEntry.move>[0]) {
    return admitted([input.from, input.to], input, NativeFileEntry.move)
  }

  export function remove(input: Parameters<typeof NativeFileEntry.remove>[0]) {
    return admitted([input.path], input, NativeFileEntry.remove)
  }
}
