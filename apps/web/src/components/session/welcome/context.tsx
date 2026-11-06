import { createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"
import type { useNavigate } from "@solidjs/router"
import { createWelcomeSelection } from "./selection"
import { createWelcomeMemory } from "./types"
import { welcomeScenes } from "./registry"

function createWelcomeState(connection: () => string) {
  let storage: Storage | undefined
  try {
    storage = window.sessionStorage
  } catch {}
  const selection = createWelcomeSelection({ ids: welcomeScenes.map((scene) => scene.id), storage })
  const [revision, setRevision] = createSignal(0)
  const current = createMemo(() => {
    revision()
    return selection.current(connection())
  })
  const experience = createMemo(() => ({ selection: current(), memory: createWelcomeMemory() }))
  return {
    experience,
    begin() {
      selection.begin(connection())
      setRevision((value) => value + 1)
    },
  }
}

const WelcomeContext = createContext<ReturnType<typeof createWelcomeState>>()

export function WelcomeProvider(props: ParentProps<{ connection: string }>) {
  const value = createWelcomeState(() => props.connection)
  return <WelcomeContext.Provider value={value}>{props.children}</WelcomeContext.Provider>
}

export function useWelcome() {
  return useContext(WelcomeContext)
}

export function useNewTaskNavigation(navigate: ReturnType<typeof useNavigate>) {
  const welcome = useWelcome()
  return (scope: string) => {
    welcome?.begin()
    navigate(`/${scope}/session`)
  }
}
