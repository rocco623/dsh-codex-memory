// Multi-frame zstd decoding for session logs.
//
// DSH appends to a session log by appending another complete zstd frame, and the
// Node build shipped in the desktop runtime decodes only the first frame (one
// frame of a 122 KB log yields 217 bytes). Node reports no consumed length, so
// this walks the frame structure described by RFC 8878 and inflates each frame.
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'

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
      if (offset + 8 > buf.length) throw new Error('truncated skippable zstd header')
      const end = offset + 8 + buf.readUInt32LE(offset + 4)
      if (end > buf.length) throw new Error('truncated skippable zstd frame')
      offset = end
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error(`unexpected zstd magic 0x${magic.toString(16)} at byte ${offset}`)
    }
    const end = frameEnd(buf, offset)
    chunks.push(zstdDecompressSync(buf.subarray(offset, end)))
    offset = end
  }
  if (offset !== buf.length) throw new Error('truncated zstd magic')
  if (chunks.length === 0) throw new Error('no zstd frames found')
  return Buffer.concat(chunks)
}

/** Stream every frame independently: desktop zlib otherwise stops after frame one. */
export async function* decodeZstdStream(input, { signal } = {}) {
 const iterator = input[Symbol.asyncIterator]?.() ?? input[Symbol.iterator]()
 let buffer = Buffer.alloc(0), ended = false, count = 0
 async function take(n, optional = false) {
  const pieces=[];let length=0
  while(length<n) {
   signal?.throwIfAborted()
   if(!buffer.length) {
    const next=await iterator.next()
    if(next.done) {ended=true;if(optional&&length===0)return null;throw new Error('truncated zstd stream')}
    buffer=Buffer.from(next.value)
   }
   const size=Math.min(n-length,buffer.length)
   pieces.push(buffer.subarray(0,size));buffer=buffer.subarray(size);length+=size
  }
  return pieces.length===1?pieces[0]:Buffer.concat(pieces,length)
 }
 async function* body(magic) {
  yield magic
  const descriptor=await take(1);yield descriptor
  const d=descriptor[0],single=(d>>5)&1
  if(d&0x18)throw new Error('reserved zstd descriptor')
  const headerBytes=(single?0:1)+DICT_ID_BYTES[d&3]+(d>>6===0?(single?1:0):FCS_BYTES[d>>6])
  if(headerBytes)yield await take(headerBytes)
  for(;;) {
   const header=await take(3);yield header
   const bits=header[0]|header[1]<<8|header[2]<<16,type=(bits>>1)&3
   if(type===3)throw new Error('reserved zstd block type')
   let remaining=type===1?1:bits>>3
   while(remaining) {const size=Math.min(remaining,65536);yield await take(size);remaining-=size}
   if(bits&1)break
  }
  if(d&4)yield await take(4)
 }
 try {
  for(;;) {
   const magic=await take(4,true)
   if(magic===null)break
   const value=magic.readUInt32LE()
   if((value&SKIPPABLE_MASK)===SKIPPABLE_MAGIC) {
    let remaining=(await take(4)).readUInt32LE()
    while(remaining){const n=Math.min(remaining,65536);await take(n);remaining-=n}
    continue
   }
   if(value!==ZSTD_MAGIC)throw new Error('unexpected zstd frame magic')
   count++
   const source=Readable.from(body(magic)),decoder=createZstdDecompress()
   source.on('error',error=>decoder.destroy(error))
   source.pipe(decoder)
   try {for await(const chunk of decoder){signal?.throwIfAborted();yield chunk}}
   finally {source.destroy();decoder.destroy()}
  }
  if(!count)throw new Error('no zstd frames found')
 } finally {if(!ended)await iterator.return?.()}
}
