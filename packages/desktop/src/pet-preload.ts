/**
 * Pet renderer preload bridge.
 *
 * Exposes a narrow, typed API to the sandboxed pet page: state/settings/sprite
 * push channels plus poke/drag intents. No Electron objects leak to the
 * renderer.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { PetBridgeState } from "./pet-window.js"
import type { PetSettingsV1, PetSpriteSheet } from "./pet-types.js"

const pet = {
  poke(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke("pet.poke") as Promise<{ ok: boolean }>
  },
  dragBy(dx: number, dy: number): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke("pet.dragBy", { dx, dy }) as Promise<{ ok: boolean }>
  },
  setDragging(dragging: boolean): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke("pet.setDragging", { dragging }) as Promise<{ ok: boolean }>
  },
  getState(): Promise<{ ok: boolean; state?: PetBridgeState }> {
    return ipcRenderer.invoke("pet.getState") as Promise<{ ok: boolean; state?: PetBridgeState }>
  },
  onState(listener: (state: PetBridgeState) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as PetBridgeState)
    ipcRenderer.on("pet:state", wrapped)
    return () => ipcRenderer.off("pet:state", wrapped)
  },
  onSettings(listener: (settings: PetSettingsV1) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as PetSettingsV1)
    ipcRenderer.on("pet:settings", wrapped)
    return () => ipcRenderer.off("pet:settings", wrapped)
  },
  onSprite(listener: (sprite: PetSpriteSheet) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as PetSpriteSheet)
    ipcRenderer.on("pet:sprite", wrapped)
    return () => ipcRenderer.off("pet:sprite", wrapped)
  },
}

contextBridge.exposeInMainWorld("synergyPet", pet)
