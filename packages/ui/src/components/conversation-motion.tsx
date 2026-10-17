import { createContext, useContext, type ParentProps } from "solid-js"

const Arrival = createContext<{ take(partID: string): boolean; revision(): number; ready(): boolean }>({
  take: () => false,
  revision: () => 0,
  ready: () => true,
})

export function ConversationMotionProvider(
  props: ParentProps<{ takeArrival?: (partID: string) => boolean; liveRevision?: () => number; ready?: () => boolean }>,
) {
  const parent = useContext(Arrival)
  return (
    <Arrival.Provider
      value={{
        take: (id) => props.takeArrival?.(id) ?? false,
        revision: () => props.liveRevision?.() ?? 0,
        ready: () => parent.ready() && (props.ready?.() ?? true),
      }}
    >
      {props.children}
    </Arrival.Provider>
  )
}

export const useConversationMotion = () => useContext(Arrival).take
export const useConversationLiveRevision = () => useContext(Arrival).revision
export const useConversationMotionReady = () => useContext(Arrival).ready
