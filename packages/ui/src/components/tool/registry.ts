import type { Component } from "solid-js"

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  title?: string
  output?: string
  status?: string
  raw?: string
  charsReceived?: number
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<string, { name: string; render?: ToolComponent }> = {}

function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}
