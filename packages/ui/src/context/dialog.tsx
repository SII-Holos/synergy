import { PortalStyleOwner, UIStyleProvider } from "./ui-style"
import {
  createContext,
  createRoot,
  createSignal,
  onCleanup,
  getOwner,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  protected: boolean
  returnFocus?: HTMLElement
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])

  const close = (id?: string) => {
    const currentStack = stack()
    const current = id ? currentStack.find((item) => item.id === id) : currentStack[currentStack.length - 1]
    if (!current) return
    const wasTop = currentStack.at(-1)?.id === current.id
    setStack((prev) => prev.filter((item) => item.id !== current.id))
    try {
      current.onClose?.()
    } finally {
      current.dispose()
      const remaining = stack().at(-1)?.id
      if (wasTop)
        requestAnimationFrame(() => {
          if (stack().at(-1)?.id === remaining && current.returnFocus?.isConnected) current.returnFocus.focus()
        })
    }
  }

  const closeAll = (includeProtected = false) => {
    for (const current of [...stack()].reverse()) {
      if (current.protected && !includeProtected) continue
      close(current.id)
    }
  }
  onCleanup(() => closeAll(true))

  const mount = (element: DialogElement, owner: Owner, onClose?: () => void, protectedSurface = false) => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const id = generateUUID()
    let dispose: (() => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d) => {
        dispose = d
        return (
          <Kobalte
            modal
            open={true}
            onOpenChange={(open) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <UIStyleProvider reset={protectedSurface}>
                <PortalStyleOwner>
                  <Kobalte.Overlay data-component="dialog-overlay" />
                  {element()}
                </PortalStyleOwner>
              </UIStyleProvider>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    const activeDispose = dispose
    if (!activeDispose) return

    const active: Active = {
      id,
      node,
      dispose: activeDispose,
      owner,
      onClose,
      protected: protectedSurface,
      returnFocus,
    }
    setStack((prev) => [...prev, active])
    return id
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    closeAll()
    return mount(element, owner, onClose)
  }

  return {
    get active() {
      const currentStack = stack()
      return currentStack[currentStack.length - 1]
    },
    get stack() {
      return stack()
    },
    close,
    push: mount,
    show,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">{ctx.stack.map((active) => active.node)}</div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    show(element: DialogElement, onClose?: () => void) {
      return ctx.show(element, owner, onClose)
    },
    push(element: DialogElement, onClose?: () => void, options?: { protected?: boolean }) {
      return ctx.push(element, owner, onClose, options?.protected)
    },
    close(id?: string) {
      ctx.close(id)
    },
  }
}
