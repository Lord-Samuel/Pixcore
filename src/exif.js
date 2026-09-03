import Crypto from 'crypto'

const EXIF_FLAG_BIT = 0x08 // VP8X flags byte, bit 3: "has EXIF metadata"

// Static TIFF header + IFD prefix. Frozen once; length at offset 14 is patched per-call.
const EXIF_ATTR = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
])

const RIFF = 0x46464952 // 'RIFF' LE
const WEBP = 0x50424557 // 'WEBP' LE
const FOURCC_VP8X = 0x58385056 // 'VP8X' LE
const FOURCC_EXIF = 0x46495845 // 'EXIF' LE

function buildExifData(metadata) {
    if (metadata.categories !== undefined && !Array.isArray(metadata.categories)) {
        throw new Error('writeExif: metadata.categories must be an array of emoji strings')
    }
    if (metadata.packId !== undefined && typeof metadata.packId !== 'string') {
        throw new Error('writeExif: metadata.packId must be a string')
    }

    const exifData = {
        'sticker-pack-id': metadata.packId || Crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': metadata.packname || '',
        'sticker-pack-publisher': metadata.author || '',
        'emojis': metadata.categories || ['']
    }

    if (metadata.publisherEmail !== undefined) exifData['sticker-pack-publisher-email'] = metadata.publisherEmail
    if (metadata.publisherWebsite !== undefined) exifData['sticker-pack-publisher-website'] = metadata.publisherWebsite
    if (metadata.androidAppStoreLink !== undefined) exifData['android-app-store-link'] = metadata.androidAppStoreLink
    if (metadata.iosAppStoreLink !== undefined) exifData['ios-app-store-link'] = metadata.iosAppStoreLink
    if (metadata.privacyPolicyWebsite !== undefined) exifData['privacy-policy-website'] = metadata.privacyPolicyWebsite
    if (metadata.licenseAgreementWebsite !== undefined) exifData['license-agreement-website'] = metadata.licenseAgreementWebsite
    if (metadata.isAvatarSticker !== undefined) exifData['is-avatar-sticker'] = metadata.isAvatarSticker ? 1 : 0

    return exifData
}

/** Scan chunks as offsets — no per-chunk objects, no string fourcc. Returns { vp8x, spans }. */
function scanChunks(buf) {
    let vp8x = -1
    const spans = []
    let offset = 12
    const len = buf.length
    while (offset + 8 <= len) {
        const fourcc = buf.readUInt32LE(offset)
        const size = buf.readUInt32LE(offset + 4)
        const paddedEnd = offset + 8 + size + (size & 1)
        if (offset + 8 + size > len) break
        if (fourcc === FOURCC_VP8X) {
            vp8x = offset
        } else if (fourcc !== FOURCC_EXIF) {
            spans.push(offset, Math.min(paddedEnd, len))
        }
        offset = paddedEnd
    }
    return { vp8x, spans }
}

function writeExif(webpBuffer, { width, height }, metadata = {}) {
    if (webpBuffer.length < 12 ||
        webpBuffer.readUInt32LE(0) !== RIFF ||
        webpBuffer.readUInt32LE(8) !== WEBP) {
        throw new Error('writeExif: input is not a valid WebP buffer')
    }

    const { vp8x, spans } = scanChunks(webpBuffer)

    if (vp8x === -1 && (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)) {
        throw new Error('writeExif: width/height required to synthesize VP8X for a simple-format WebP')
    }

    const json = JSON.stringify(buildExifData(metadata))
    const jsonLen = Buffer.byteLength(json, 'utf-8')
    const exifPayloadLen = EXIF_ATTR.length + jsonLen
    const exifChunkLen = 8 + exifPayloadLen + (exifPayloadLen & 1)

    const VP8X_LEN = 18 // 8 header + 10 payload

    let keptLen = 0
    for (let i = 0; i < spans.length; i += 2) keptLen += spans[i + 1] - spans[i]

    const totalLen = 12 + VP8X_LEN + keptLen + exifChunkLen
    const out = Buffer.allocUnsafe(totalLen)

    // RIFF header
    out.writeUInt32LE(RIFF, 0)
    out.writeUInt32LE(totalLen - 8, 4)
    out.writeUInt32LE(WEBP, 8)

    // VP8X chunk — copy existing (set EXIF flag) or synthesize for simple-format WebPs.
    let pos = 12
    if (vp8x !== -1) {
        webpBuffer.copy(out, pos, vp8x, vp8x + VP8X_LEN)
        out[pos + 8] |= EXIF_FLAG_BIT
    } else {
        out.writeUInt32LE(FOURCC_VP8X, pos)
        out.writeUInt32LE(10, pos + 4)
        out[pos + 8] = EXIF_FLAG_BIT
        out[pos + 9] = 0
        out[pos + 10] = 0
        out[pos + 11] = 0
        out.writeUIntLE(width - 1, pos + 12, 3)
        out.writeUIntLE(height - 1, pos + 15, 3)
    }
    pos += VP8X_LEN

    // Remaining chunks: straight memcpy per span.
    for (let i = 0; i < spans.length; i += 2) {
        webpBuffer.copy(out, pos, spans[i], spans[i + 1])
        pos += spans[i + 1] - spans[i]
    }

    // EXIF chunk written in place.
    out.writeUInt32LE(FOURCC_EXIF, pos)
    out.writeUInt32LE(exifPayloadLen, pos + 4)
    EXIF_ATTR.copy(out, pos + 8)
    out.writeUIntLE(jsonLen, pos + 8 + 14, 4)
    out.write(json, pos + 8 + EXIF_ATTR.length, jsonLen, 'utf-8')
    if (exifPayloadLen & 1) out[pos + 8 + exifPayloadLen] = 0

    return out
}

export { writeExif, buildExifData }
