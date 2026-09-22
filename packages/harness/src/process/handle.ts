import type { EventEmitter } from "node:events"
import type { Readable, Writable } from "node:stream"

export interface ProcessHandle extends EventEmitter {
  readonly pid?: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  alive?(): boolean | undefined
  stop?(): Promise<void>
  kill(signal?: NodeJS.Signals | number): boolean
}
