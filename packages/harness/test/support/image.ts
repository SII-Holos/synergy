import { deflateSync } from "node:zlib"

export function pngImage(size: number) {
  function chunk(type: string, data: Uint8Array) {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const result = Buffer.alloc(body.length + 8)
    result.writeUInt32BE(data.length)
    body.copy(result, 4)
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(size * (size * 3 + 1))
  let seed = 42
  for (let row = 0; row < size; row++) {
    for (let column = 1; column <= size * 3; column++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      pixels[row * (size * 3 + 1) + column] = seed >>> 24
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")
}
