import { createContext, createMemo, useContext, type ParentProps } from "solid-js"
import * as Router from "@solidjs/router"
import { useViewActivity } from "./view-residency"

type Params = Record<string, string | undefined>
const Context = createContext<{ params: Params; location: ReturnType<typeof Router.useLocation> }>()

export function SessionRouteProvider(props: ParentProps<{ params: Params }>) {
  const active = useViewActivity()
  const route = Router.useLocation()
  const snapshot = createMemo<ReturnType<typeof Router.useLocation>>((previous) =>
    active() || !previous ? { ...route } : previous,
  )
  const location = new Proxy({} as ReturnType<typeof Router.useLocation>, {
    get: (_, name: keyof ReturnType<typeof Router.useLocation>) => snapshot()[name],
  })
  return <Context.Provider value={{ params: { ...props.params }, location }}>{props.children}</Context.Provider>
}

export function useParams<T extends Params = Params>(): T {
  return (useContext(Context)?.params ?? Router.useParams()) as T
}

export const useLocation = () => useContext(Context)?.location ?? Router.useLocation()
