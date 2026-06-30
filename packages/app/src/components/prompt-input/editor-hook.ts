import type { Accessor } from "solid-js"
import { createEffect, on } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import {
  type ContentPart,
  DEFAULT_PROMPT,
  type NoteAttachmentPart,
  type Prompt,
  type SessionAttachmentPart,
  type UploadedAttachmentPart,
  isPromptEqual,
  usePrompt,
} from "@/context/prompt"
import { createFilePill, createTextFragment, getCursorPosition, getNodeLength, setCursorPosition } from "./editor-dom"
import { inlineText, isInlinePart } from "./content"
import type { PromptInputStore } from "./types"

type PromptEditorInput = {
  editor: () => HTMLDivElement
  uploadedAttachments: Accessor<UploadedAttachmentPart[]>
  noteAttachments: Accessor<NoteAttachmentPart[]>
  sessionAttachments: Accessor<SessionAttachmentPart[]>
  store: PromptInputStore
  setStore: SetStoreFunction<PromptInputStore>
  atOnInput: (query: string) => void
  slashOnInput: (query: string) => void
  queueScroll: () => void
}

export function usePromptEditor(input: PromptEditorInput) {
  const prompt = usePrompt()

  const isNormalizedEditor = () =>
    Array.from(input.editor().childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        const nextIsBr = next?.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === "BR"
        if (!prevIsBr && !nextIsBr) return false
        if (nextIsBr && !prevIsBr && prev) return false
        return true
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    const editor = input.editor()
    editor.innerHTML = ""
    for (const part of parts) {
      if (part.type === "text") {
        editor.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file") {
        editor.appendChild(createFilePill(part))
      }
    }
  }

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      const content = buffer.replace(/\r\n?/g, "\n").replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(input.editor().childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const editor = input.editor()
        const inputParts = currentParts.filter(isInlinePart) as Prompt
        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        const selection = window.getSelection()
        let cursorPosition: number | null = null
        if (selection && selection.rangeCount > 0 && editor.contains(selection.anchorNode)) {
          cursorPosition = getCursorPosition(editor)
        }

        renderEditor(inputParts)

        if (cursorPosition !== null) {
          setCursorPosition(editor, cursorPosition)
        }
      },
    ),
  )

  const handleInput = () => {
    const editor = input.editor()
    const rawParts = parseFromDOM()
    const attachments = input.uploadedAttachments()
    const cursorPosition = getCursorPosition(editor)
    const rawText = inlineText(rawParts)
    const trimmed = rawText.replace(/\u200B/g, "").trim()
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset =
      trimmed.length === 0 &&
      !hasNonText &&
      attachments.length === 0 &&
      input.noteAttachments().length === 0 &&
      input.sessionAttachments().length === 0

    if (shouldReset) {
      input.setStore("popover", null)
      if (input.store.historyIndex >= 0 && !input.store.applyingHistory) {
        input.setStore("historyIndex", -1)
        input.setStore("savedPrompt", null)
      }
      if (prompt.dirty()) {
        prompt.set(DEFAULT_PROMPT, 0)
      }
      input.queueScroll()
      return
    }

    const shellMode = input.store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        input.atOnInput(atMatch[1])
        input.setStore("popover", "at")
      } else if (slashMatch) {
        input.slashOnInput(slashMatch[1])
        input.setStore("popover", "slash")
      } else {
        input.setStore("popover", null)
      }
    } else {
      input.setStore("popover", null)
    }

    if (input.store.historyIndex >= 0 && !input.store.applyingHistory) {
      input.setStore("historyIndex", -1)
      input.setStore("savedPrompt", null)
    }

    prompt.set([...rawParts, ...attachments, ...input.noteAttachments(), ...input.sessionAttachments()], cursorPosition)
    input.queueScroll()
  }

  const setRangeEdge = (range: Range, edge: "start" | "end", offset: number) => {
    let remaining = offset
    const nodes = Array.from(input.editor().childNodes)

    for (const node of nodes) {
      const length = getNodeLength(node)
      const isText = node.nodeType === Node.TEXT_NODE
      const isPill = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.type === "file"
      const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

      if (isText && remaining <= length) {
        if (edge === "start") range.setStart(node, remaining)
        if (edge === "end") range.setEnd(node, remaining)
        return
      }

      if ((isPill || isBreak) && remaining <= length) {
        if (edge === "start" && remaining === 0) range.setStartBefore(node)
        if (edge === "start" && remaining > 0) range.setStartAfter(node)
        if (edge === "end" && remaining === 0) range.setEndBefore(node)
        if (edge === "end" && remaining > 0) range.setEndAfter(node)
        return
      }

      remaining -= length
    }
  }

  const addPart = (part: ContentPart) => {
    const editor = input.editor()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const cursorPosition = getCursorPosition(editor)
    const currentPrompt = prompt.current()
    const rawText = inlineText(currentPrompt)
    const textBeforeCursor = rawText.substring(0, cursorPosition)
    const atMatch = textBeforeCursor.match(/@(\S*)$/)

    if (part.type === "file") {
      const pill = createFilePill(part)
      const gap = document.createTextNode(" ")
      const range = selection.getRangeAt(0)

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(range, "start", start)
        setRangeEdge(range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else if (part.type === "text") {
      const range = selection.getRangeAt(0)
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(last)
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    input.setStore("popover", null)
  }

  return {
    addPart,
    handleInput,
  }
}
