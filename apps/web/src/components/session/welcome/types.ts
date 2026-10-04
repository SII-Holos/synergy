import type { MessageDescriptor } from "@lingui/core"
import type { Accessor, Component } from "solid-js"

export type WelcomeMemory = {
  read: <T>(initialize: () => T) => T
  write: (value: unknown) => void
}

export function createWelcomeMemory(): WelcomeMemory {
  let value: unknown
  return {
    read<T>(initialize: () => T): T {
      if (value === undefined) value = initialize()
      return value as T
    },
    write(next) {
      value = next
    },
  }
}

export type WelcomeSceneProps = {
  seed: number
  active: Accessor<boolean>
  reducedMotion: Accessor<boolean>
  memory: WelcomeMemory
  interact: () => void
  pause: () => void
}

export type WelcomeSceneDefinition = {
  id: string
  title: MessageDescriptor
  load: () => Promise<{ default: Component<WelcomeSceneProps> }>
}
