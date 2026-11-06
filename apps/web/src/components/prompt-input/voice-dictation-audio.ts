/**
 * Client-side dictation audio preparation.
 *
 * Browser microphone recordings frequently land far below full scale (quiet
 * input level, distance from the mic), and speech-recognition VADs treat very
 * quiet clips as silence and return an empty transcript. Before uploading, the
 * recording is decoded, gain-normalized toward a target peak, and re-encoded
 * as uncompressed PCM16 WAV (which also removes container compatibility
 * concerns). Clips that are effectively digital silence are reported as such
 * so the user is told to move closer instead of seeing a provider error.
 *
 * The AudioContext decoding stays in the caller; this module is pure.
 */

export const SILENCE_PEAK_THRESHOLD = 0.004 // ≈ -48 dBFS: essentially digital silence (no audio reaching the device)
export const TARGET_PEAK = 0.4 // ≈ -8 dBFS after normalization, headroom below clipping

/** Largest absolute sample of a mono Float32 buffer (-1..1). */
export function audioPeak(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]!)
    if (value > peak) peak = value
  }
  return peak
}

/** Linear gain that lifts `peak` to `TARGET_PEAK`; 1 when the clip is already loud enough. */
export function gainToTarget(peak: number): number {
  if (peak <= 0) return 1
  const gain = TARGET_PEAK / peak
  return gain > 1 ? gain : 1
}

/** Apply gain with clipping, returning a new normalized Float32 buffer. */
export function applyGain(samples: Float32Array, gain: number): Float32Array {
  if (gain === 1) return samples
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]! * gain
    out[i] = value > 1 ? 1 : value < -1 ? -1 : value
  }
  return out
}

/**
 * Encode mono Float32 samples (-1..1) as a canonical little-endian PCM16 WAV
 * Blob. Used to hand the STT service a deterministic container.
 */
export function encodePcm16WavBlob(samples: Float32Array, sampleRate: number, mimeType = "audio/wav"): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  function ascii(offset: number, text: string) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true)
  }
  return new Blob([buffer], { type: mimeType })
}

/** Browser decode result shape for `normalizeDictationBlob`. */
export interface DecodedAudio {
  channelData: Float32Array
  sampleRate: number
}

/**
 * Decode a recorded blob, measure its peak, and either report it as silence
 * (nothing audible to transcribe) or hand back a gain-normalized PCM16 WAV
 * File. Decoding failures fall back to the original blob so exotic containers
 * still reach the server instead of being dropped client-side.
 */
export async function normalizeDictationBlob(
  blob: Blob,
  decode: (arrayBuffer: ArrayBuffer) => Promise<DecodedAudio>,
): Promise<{ kind: "audio"; file: File; peak: number } | { kind: "silence"; peak: number }> {
  const arrayBuffer = await blob.arrayBuffer()
  let decoded: DecodedAudio
  try {
    decoded = await decode(arrayBuffer)
  } catch {
    return { kind: "audio", file: new File([blob], "dictation.webm", { type: blob.type || "audio/webm" }), peak: 1 }
  }
  const peak = audioPeak(decoded.channelData)
  if (peak < SILENCE_PEAK_THRESHOLD) return { kind: "silence", peak }
  const normalized = applyGain(decoded.channelData, gainToTarget(peak))
  const wavBlob = encodePcm16WavBlob(normalized, decoded.sampleRate)
  return { kind: "audio", file: new File([wavBlob], "dictation.wav", { type: "audio/wav" }), peak }
}
