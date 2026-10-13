import { createContext, type Accessor } from "solid-js"

export const SessionWorkbenchChrome = createContext<Accessor<HTMLElement | undefined>>()

export const SessionPromptDockAnchor = createContext<{
  element: Accessor<HTMLElement | undefined>
  mount(element: HTMLElement | undefined, releaseOf?: HTMLElement): void
}>()
