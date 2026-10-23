// Multi-frame zstd decoding for session logs.
//
// DSH appends to a session log by appending another complete zstd frame, and the
// Node build shipped in the desktop runtime decodes only the first frame (one
// frame of a 122 KB log yields 217 bytes). Node reports no consumed length, so
// this walks the frame structure described by RFC 8878 and inflates each frame.
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MASK = 0xfffffff0
const SKIPPABLE_MAGIC = 0x184d2a50
const DICT_ID_BYTES = [0, 1, 2, 4]
const FCS_BYTES = [0, 2, 4, 8]

/** Offset just past the frame that starts at `start`. */
function frameEnd(buf, start) {
  let p = start + 4
  if (p >= buf.length) throw new Error('truncated zstd frame header')
  const descriptor = buf[p]
  p += 1
  const fcsFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += DICT_ID_BYTES[dictFlag]
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : FCS_BYTES[fcsFlag]

  for (;;) {
    if (p + 3 > buf.length) throw new Error('truncated zstd block header')
    const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const isLast = header & 1
    const type = (header >> 1) & 3
    const size = header >> 3
    if (type === 3) throw new Error('reserved zstd block type')
    p += type === 1 ? 1 : size // RLE blocks store a single byte
    if (isLast) break
  }
  if (hasChecksum) p += 4
  if (p > buf.length) throw new Error('truncated zstd frame')
  return p
}

export function decodeZstdFrames(buf) {
  const chunks = []
  let offset = 0
  while (offset + 4 <= buf.length) {
    const magic = buf.readUInt32LE(offset)
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (offset + 8 > buf.length) break
      offset += 8 + buf.readUInt32LE(offset + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error(`unexpected zstd magic 0x${magic.toString(16)} at byte ${offset}`)
    }
    const end = frameEnd(buf, offset)
    chunks.push(zstdDecompressSync(buf.subarray(offset, end)))
    offset = end
  }
  if (chunks.length === 0) throw new Error('no zstd frames found')
  return Buffer.concat(chunks)
}
