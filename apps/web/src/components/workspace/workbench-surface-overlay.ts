import { createContext, type Accessor } from "solid-js"

export const WorkbenchSurfaceOverlay = createContext<Accessor<boolean>>(() => false)
