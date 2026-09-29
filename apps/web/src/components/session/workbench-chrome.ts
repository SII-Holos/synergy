import { createContext, type Accessor } from "solid-js"

export const SessionWorkbenchChrome = createContext<Accessor<HTMLElement | undefined>>()
