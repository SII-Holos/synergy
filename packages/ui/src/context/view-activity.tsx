import { createContext, onCleanup, createSignal, useContext, type Accessor, type ParentProps } from "solid-js"

const ActivityContext = createContext<Accessor<boolean>>(() => true)

export function ViewActivityProvider(props: ParentProps<{ active: Accessor<boolean> }>) {
  const parent = useContext(ActivityContext)
  const [mounted, setMounted] = createSignal(true)
  onCleanup(() => setMounted(false))
  return (
    <ActivityContext.Provider value={() => mounted() && parent() && props.active()}>
      {props.children}
    </ActivityContext.Provider>
  )
}

export const useViewActivity = () => useContext(ActivityContext)
