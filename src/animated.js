const str4 = (buf, off) => Buffer.from(buf.buffer, buf.byteOffset + off, 4).toString('ascii')

const readU24LE = (buf, off) => buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)
const writeU24LE = (buf, off, val) => {
    buf[off]     =  val        & 0xff
    buf[off + 1] = (val >> 8)  & 0xff
    buf[off + 2] = (val >> 16) & 0xff
}

const hasRiffWebpHeader = (buf) =>
    buf.length >= 12 && str4(buf, 0) === 'RIFF' && str4(buf, 8) === 'WEBP'


function isAnimatedWebp(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (!hasRiffWebpHeader(buf)) return false
    let off = 12
    while (off + 8 <= buf.length) {
        const tag = str4(buf, off)
        const size = buf.readUInt32LE(off + 4)
        if (tag === 'VP8X') return !!(buf[off + 8] & 0x02)
        if (tag === 'ANIM' || tag === 'ANMF') return true
        off += 8 + size + (size & 1)
    }
    return false
}


function parseAnimatedWebp(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
    if (!hasRiffWebpHeader(buf)) throw new Error('parseAnimatedWebp: not a WebP file')

    let width = 0, height = 0, loop = 0
    let background = [0, 0, 0, 0]
    const frames = []

    let off = 12
    while (off + 8 <= buf.length) {
        const tag = str4(buf, off)
        const size = buf.readUInt32LE(off + 4)
        const end = off + 8 + size
        if (end > buf.length) break

        if (tag === 'VP8X') {
            width  = readU24LE(buf, off + 8 + 4) + 1
            height = readU24LE(buf, off + 8 + 7) + 1
        } else if (tag === 'ANIM') {
            // Background stored as BGRA, loop count is uint16 LE
            background = [buf[off + 10], buf[off + 9], buf[off + 8], buf[off + 11]]
            loop = buf.readUInt16LE(off + 12)
        } else if (tag === 'ANMF') {
            if (end < off + 24) { off = end + (size & 1); continue }

            const frameX   = readU24LE(buf, off + 8) * 2
            const frameY   = readU24LE(buf, off + 11) * 2
            const frameW   = readU24LE(buf, off + 14) + 1
            const frameH   = readU24LE(buf, off + 17) + 1
            const duration = readU24LE(buf, off + 20)
            const flags    = buf[off + 23]
            const blend    = (flags & 0x02) ? 'no-blend' : 'alpha-blend'
            const dispose  = (flags & 0x01) ? 'restore-bg' : 'none'

            const subChunks = buf.subarray(off + 24, end)
            const frameWebp = wrapFrameAsStaticWebp(subChunks, frameW, frameH)

            frames.push({
                data: frameWebp,
                width: frameW,
                height: frameH,
                left: frameX,
                top: frameY,
                duration,
                blend,
                dispose,
            })
        }

        off = end + (size & 1)
    }

    return { width, height, loop, background, frames }
}

/** Wrap an ANMF frame's ALPH/VP8/VP8L sub-chunks as a standalone static WebP. */
function wrapFrameAsStaticWebp(subChunks, width, height) {
    // Detect alpha to set the VP8X flag correctly
    let hasAlpha = false
    let off = 0
    while (off + 8 <= subChunks.length) {
        const tag = str4(subChunks, off)
        const size = subChunks.readUInt32LE(off + 4)
        if (tag === 'ALPH' || tag === 'VP8L') { hasAlpha = true; break }
        if (tag === 'VP8 ') break
        off += 8 + size + (size & 1)
    }

    const vp8x = Buffer.alloc(18)
    vp8x.write('VP8X', 0, 'ascii')
    vp8x.writeUInt32LE(10, 4)
    vp8x[8] = hasAlpha ? 0x10 : 0x00
    writeU24LE(vp8x, 12, width - 1)
    writeU24LE(vp8x, 15, height - 1)

    const riffSize = 4 + vp8x.length + subChunks.length
    const out = Buffer.alloc(8 + riffSize)
    out.write('RIFF', 0, 'ascii')
    out.writeUInt32LE(riffSize, 4)
    out.write('WEBP', 8, 'ascii')
    out.set(vp8x, 12)
    out.set(subChunks, 12 + vp8x.length)
    return out
}

/**
 * Decode every frame and composite them into full-canvas RGBA frames.
 * `webpDecode` is the raw static-WebP decoder function
 * (Buffer -> { data: Uint8Array, width, height }).
 */
async function decodeAnimatedWebp(input, webpDecode) {
    const { width, height, loop, background, frames: rawFrames } = parseAnimatedWebp(input)
    if (!rawFrames.length) return { width, height, loop, background, frames: [] }

    const [br, bg, bb, ba] = background
    const canvas = new Uint8Array(width * height * 4)
    if (br || bg || bb || ba) {
        for (let i = 0; i < canvas.length; i += 4) {
            canvas[i] = br; canvas[i + 1] = bg
            canvas[i + 2] = bb; canvas[i + 3] = ba
        }
    }

    const out = []

    for (const frame of rawFrames) {
        const decoded = await webpDecode(frame.data)
        const src = decoded.data
        const sw = decoded.width
        const sh = decoded.height

        for (let y = 0; y < sh; y++) {
            const cy = frame.top + y
            if (cy < 0 || cy >= height) continue
            for (let x = 0; x < sw; x++) {
                const cx = frame.left + x
                if (cx < 0 || cx >= width) continue

                const s = (y * sw + x) * 4
                const d = (cy * width + cx) * 4
                const sa = src[s + 3]

                if (frame.blend === 'no-blend') {
                    canvas[d] = src[s]
                    canvas[d + 1] = src[s + 1]
                    canvas[d + 2] = src[s + 2]
                    canvas[d + 3] = sa
                    continue
                }
                if (sa === 0) continue
                if (sa === 255) {
                    canvas[d] = src[s]
                    canvas[d + 1] = src[s + 1]
                    canvas[d + 2] = src[s + 2]
                    canvas[d + 3] = 255
                    continue
                }
                const srcA = sa / 255
                const dstA = canvas[d + 3] / 255
                const outA = srcA + dstA * (1 - srcA)
                if (outA === 0) {
                    canvas[d] = canvas[d + 1] = canvas[d + 2] = 0
                } else {
                    canvas[d]     = Math.round((src[s]     * srcA + canvas[d]     * dstA * (1 - srcA)) / outA)
                    canvas[d + 1] = Math.round((src[s + 1] * srcA + canvas[d + 1] * dstA * (1 - srcA)) / outA)
                    canvas[d + 2] = Math.round((src[s + 2] * srcA + canvas[d + 2] * dstA * (1 - srcA)) / outA)
                }
                canvas[d + 3] = Math.round(outA * 255)
            }
        }

        out.push({
            data: new Uint8Array(canvas),
            width, height,
            duration: frame.duration,
            format: 'raw',
            originalSize: canvas.length,
        })

        if (frame.dispose === 'restore-bg') {
            for (let y = 0; y < sh; y++) {
                const cy = frame.top + y
                if (cy < 0 || cy >= height) continue
                for (let x = 0; x < sw; x++) {
                    const cx = frame.left + x
                    if (cx < 0 || cx >= width) continue
                    const d = (cy * width + cx) * 4
                    canvas[d] = br; canvas[d + 1] = bg
                    canvas[d + 2] = bb; canvas[d + 3] = ba
                }
            }
        }
    }

    return { width, height, loop, background, frames: out }
}


function extractFrameChunks(buf) {
    if (!hasRiffWebpHeader(buf)) throw new Error('extractFrameChunks: not a WebP file')
    let hasAlpha = false
    const parts = []
    let off = 12
    while (off + 8 <= buf.length) {
        const tag = str4(buf, off)
        const size = buf.readUInt32LE(off + 4)
        const end = off + 8 + size + (size & 1)
        if (tag === 'VP8 ' || tag === 'VP8L' || tag === 'ALPH') {
            if (tag === 'ALPH' || tag === 'VP8L') hasAlpha = true
            parts.push(buf.subarray(off, end))
        }
        off = end
    }
    return { chunks: Buffer.concat(parts.map(p => Buffer.from(p))), hasAlpha }
}


function buildAnimatedWebpContainer(encodedFrames, { width, height, loop = 0, background = [0, 0, 0, 0] } = {}) {
    if (!encodedFrames.length) throw new Error('buildAnimatedWebpContainer: no frames provided')

    let hasAlpha = false
    const anmfChunks = []

    for (const { webpBuffer, duration } of encodedFrames) {
        const { chunks: subChunks, hasAlpha: frameHasAlpha } = extractFrameChunks(webpBuffer)
        if (frameHasAlpha) hasAlpha = true

        const payloadLen = 16 + subChunks.length
        const chunk = Buffer.alloc(8 + payloadLen)
        chunk.write('ANMF', 0, 'ascii')
        chunk.writeUInt32LE(payloadLen, 4)
        writeU24LE(chunk, 8, 0)                  // frame X (2px units)
        writeU24LE(chunk, 11, 0)                 // frame Y
        writeU24LE(chunk, 14, width - 1)         // frame width - 1
        writeU24LE(chunk, 17, height - 1)        // frame height - 1
        writeU24LE(chunk, 20, duration)
        chunk[23] = 0x00                         // alpha-blend, dispose:none (full-frame, doesn't matter)
        subChunks.copy(chunk, 24)
        anmfChunks.push(chunk)
    }

    const [r, g, b, a] = background
    const anim = Buffer.alloc(14)
    anim.write('ANIM', 0, 'ascii')
    anim.writeUInt32LE(6, 4)
    anim[8] = b; anim[9] = g; anim[10] = r; anim[11] = a  // stored BGRA
    anim.writeUInt16LE(loop, 12)

    const vp8x = Buffer.alloc(18)
    vp8x.write('VP8X', 0, 'ascii')
    vp8x.writeUInt32LE(10, 4)
    vp8x[8] = 0x02 | (hasAlpha ? 0x10 : 0x00)     // animation flag (+ alpha flag)
    writeU24LE(vp8x, 12, width - 1)
    writeU24LE(vp8x, 15, height - 1)

    const bodyLen = vp8x.length + anim.length + anmfChunks.reduce((n, c) => n + c.length, 0)
    const riffSize = 4 + bodyLen // "WEBP" + all chunks

    const out = Buffer.alloc(8 + riffSize)
    out.write('RIFF', 0, 'ascii')
    out.writeUInt32LE(riffSize, 4)
    out.write('WEBP', 8, 'ascii')
    let off = 12
    vp8x.copy(out, off); off += vp8x.length
    anim.copy(out, off); off += anim.length
    for (const chunk of anmfChunks) { chunk.copy(out, off); off += chunk.length }

    return out
}

export {
    isAnimatedWebp,
    parseAnimatedWebp,
    decodeAnimatedWebp,
    extractFrameChunks,
    buildAnimatedWebpContainer,
}
