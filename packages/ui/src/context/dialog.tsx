import {
  createContext,
  createRoot,
  createSignal,
  getOwner,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])

  const close = (id?: string) => {
    const currentStack = stack()
    const current = id ? currentStack.find((item) => item.id === id) : currentStack[currentStack.length - 1]
    if (!current) return
    current.onClose?.()
    current.dispose()
    setStack((prev) => prev.filter((item) => item.id !== current.id))
  }

  const closeAll = () => {
    const currentStack = stack()
    for (const current of [...currentStack].reverse()) {
      current.onClose?.()
      current.dispose()
    }
    setStack([])
  }

  const mount = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    const id = Math.random().toString(36).slice(2)
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
              <Kobalte.Overlay data-component="dialog-overlay" />
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    const activeDispose = dispose
    if (!activeDispose) return

    const active: Active = { id, node, dispose: activeDispose, owner, onClose }
    setStack((prev) => [...prev, active])
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    closeAll()
    mount(element, owner, onClose)
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
      const base = ctx.active?.owner ?? owner
      ctx.show(element, base, onClose)
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.active?.owner ?? owner
      ctx.push(element, base, onClose)
    },
    close() {
      ctx.close()
    },
  }
}
