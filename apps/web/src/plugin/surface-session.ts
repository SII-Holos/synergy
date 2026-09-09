import type { PluginInputService, PluginSessionService } from "@ericsanchezok/synergy-plugin"
import type { createPluginSurfaceAccess } from "./surface-access"

type Access = ReturnType<typeof createPluginSurfaceAccess>

export function bindPluginInput(source: PluginInputService, access: Access): PluginInputService {
  const read = () => {
    access.require("composer.read")
    return source
  }
  const write = () => {
    access.require("composer.write")
    return source
  }
  return {
    editor: {
      mount: (element, scroller) => access.own("composer.write", () => source.editor.mount(element, scroller)),
      beforeInput: (event) => write().editor.beforeInput(event),
      input: () => write().editor.input(),
      paste: (event) => access.run("composer.write", () => source.editor.paste(event)),
      keyDown: (event) => write().editor.keyDown(event),
      completion: () => read().editor.completion(),
      placeholder: () => read().editor.placeholder(),
      label: () => read().editor.label(),
    },
    readOnly: () => read().readOnly(),
    composing: () => read().composing(),
    primaryAction: () => read().primaryAction(),
    current: () => read().current(),
    ready: () => read().ready(),
    canSubmit: () => {
      access.require("session.submit")
      return read().canSubmit()
    },
    submitting: () => read().submitting(),
    stopping: () => read().stopping(),
    dragging: () => read().dragging(),
    className: () => read().className(),
    applyEdits: (edits) => access.run("composer.write", () => source.applyEdits(edits)),
    select: (range) => write().select(range),
    setComposing: (value) => write().setComposing(value),
    setMode: (mode) => write().setMode(mode),
    submit: () => access.run("session.submit", () => source.submit()),
    stop: () => access.run("session.control", () => source.stop()),
    attachments: () => read().attachments(),
    addAttachments: (files) => access.run("composer.write", () => source.addAttachments(files)),
    removeAttachment: (id) => write().removeAttachment(id),
    agents: () => read().agents(),
    agent: () => read().agent(),
    selectAgent: (id) => write().selectAgent(id),
    models: () => read().models(),
    model: () => read().model(),
    selectModel: (model) => write().selectModel(model),
    variants: () => read().variants(),
    variant: () => read().variant(),
    selectVariant: (variant) => write().selectVariant(variant),
    render: (part) => read().render(part),
    dragOver: (event) => write().dragOver(event),
    dragLeave: (event) => write().dragLeave(event),
    drop: (event) => access.run("composer.write", () => source.drop(event)),
  }
}

export function bindPluginSession(source: PluginSessionService, access: Access): PluginSessionService {
  const read = () => {
    access.require("session.read")
    return source
  }
  return {
    current: () => read().current(),
    messages: () => read().messages(),
    message: (id) => read().message(id),
    parts: (id) => read().parts(id),
    status: () => read().status(),
    ready: () => read().ready(),
    history: () => read().history(),
    loadEarlier: () => access.run("session.read", () => source.loadEarlier()),
    returnLatest: () => access.run("session.read", () => source.returnLatest()),
    refresh: () => access.run("session.read", () => source.refresh()),
    rewind: (id) => {
      access.require("session.control")
      source.rewind(id)
    },
    fork: (id) => {
      access.require("session.control")
      source.fork(id)
    },
  }
}
