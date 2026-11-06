/**
 * Peak normalization for PCM16 RIFF/WAVE audio.
 *
 * Speech-synthesis providers (CosyVoice, gpt-4o-mini-tts, …) return clips
 * mastered far below full scale (peaks around -16 dBFS), which users hear as
 * unexpectedly quiet playback next to the completion chime. WAV output is
 * uncompressed little-endian PCM16, so loudness can be normalized in pure
 * JavaScript before the clip is stored: no decoder dependency is needed.
 *
 * Only canonical PCM16 WAVE files are touched; anything else (different
 * bit depth, float PCM, non-RIFF payloads, silent clips) is returned as-is.
 */

const TARGET_PEAK_DB = -1.0

export function peakNormalizeWavPcm16(data: Uint8Array, targetPeakDb = TARGET_PEAK_DB): Uint8Array {
  if (!isPcm16Wav(data)) return data

  const { dataOffset, dataLength } = wavDataRange(data)
  if (dataLength === 0) return data

  let peak = 0
  for (let i = 0; i < dataLength; i += 2) {
    const sample = data[dataOffset + i]! | (data[dataOffset + i + 1]! << 8)
    const value = sample & 0x8000 ? sample - 0x10000 : sample
    const abs = value < 0 ? -value : value
    if (abs > peak) peak = abs
  }
  if (peak === 0) return data

  const target = Math.pow(10, targetPeakDb / 20) * 32768
  const gain = target / peak
  if (gain <= 1.001) return data // already at or above target — do not amplify

  const out = new Uint8Array(data)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let i = 0; i < dataLength; i += 2) {
    const sample = view.getInt16(dataOffset + i, true)
    let scaled = Math.round(sample * gain)
    if (scaled > 32767) scaled = 32767
    else if (scaled < -32768) scaled = -32768
    view.setInt16(dataOffset + i, scaled, true)
  }
  return out
}

/** True for little-endian PCM16 RIFF/WAVE with an fmt block declaring 16-bit PCM. */
export function isPcm16Wav(data: Uint8Array): boolean {
  if (data.length < 44) return false
  if (ascii(data, 0, 4) !== "RIFF") return false
  if (ascii(data, 8, 4) !== "WAVE") return false

  let offset = 12
  while (offset + 8 <= data.length) {
    const chunkID = ascii(data, offset, 4)
    const chunkSize = le32(data, offset + 4)
    if (chunkID === "fmt ") {
      const audioFormat = le16(data, offset + 8)
      const bitsPerSample = le16(data, offset + 22)
      return audioFormat === 1 && bitsPerSample === 16
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  return false
}

/** Byte range of the `data` chunk payload for a PCM16 WAVE. */
export function wavDataRange(data: Uint8Array): { dataOffset: number; dataLength: number } {
  let offset = 12
  while (offset + 8 <= data.length) {
    const chunkID = ascii(data, offset, 4)
    const chunkSize = le32(data, offset + 4)
    if (chunkID === "data") return { dataOffset: offset + 8, dataLength: Math.min(chunkSize, data.length - offset - 8) }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  return { dataOffset: 0, dataLength: 0 }
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  let result = ""
  for (let i = 0; i < length; i++) result += String.fromCharCode(data[offset + i] ?? 0)
  return result
}

function le16(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8)
}

function le32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  )
}
