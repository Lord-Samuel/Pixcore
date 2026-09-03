import Crypto from 'crypto'

const EXIF_FLAG_BIT = 0x08 // VP8X flags byte, bit 3: "has EXIF metadata"

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

function buildExifPayload(metadata) {
    const exifData = buildExifData(metadata)

    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ])

    const jsonBuffer = Buffer.from(JSON.stringify(exifData), 'utf-8')
    const payload = Buffer.concat([exifAttr, jsonBuffer])
    payload.writeUIntLE(jsonBuffer.length, 14, 4)
    return payload
}

function makeChunk(fourcc, payload) {
    const header = Buffer.alloc(8)
    header.write(fourcc, 0, 4, 'ascii')
    header.writeUInt32LE(payload.length, 4)
    const needsPad = payload.length % 2 !== 0
    return Buffer.concat(needsPad ? [header, payload, Buffer.alloc(1)] : [header, payload])
}

function parseChunks(webpBuffer) {
    const chunks = []
    let offset = 12
    while (offset + 8 <= webpBuffer.length) {
        const fourcc = webpBuffer.toString('ascii', offset, offset + 4)
        const size = webpBuffer.readUInt32LE(offset + 4)
        const paddedSize = size + (size % 2)
        const dataStart = offset + 8
        if (dataStart + size > webpBuffer.length) break
        chunks.push({ fourcc, size, raw: webpBuffer.subarray(offset, dataStart + paddedSize) })
        offset = dataStart + paddedSize
    }
    return chunks
}

function writeExif(webpBuffer, { width, height }, metadata = {}) {
    if (webpBuffer.length < 12 ||
        webpBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
        webpBuffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('writeExif: input is not a valid WebP buffer')
    }

    const chunks = parseChunks(webpBuffer)
    const exifChunk = makeChunk('EXIF', buildExifPayload(metadata))

    let vp8xChunk
    const rest = []
    for (const chunk of chunks) {
        if (chunk.fourcc === 'EXIF') continue
        if (chunk.fourcc === 'VP8X') { vp8xChunk = chunk; continue }
        rest.push(chunk)
    }

    if (vp8xChunk) {
        const updated = Buffer.from(vp8xChunk.raw)
        updated[8] |= EXIF_FLAG_BIT
        vp8xChunk = { raw: updated }
    } else {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error('writeExif: width/height required to synthesize VP8X for a simple-format WebP')
        }
        const vp8xPayload = Buffer.alloc(10)
        vp8xPayload[0] = EXIF_FLAG_BIT
        vp8xPayload.writeUIntLE(width - 1, 4, 3)
        vp8xPayload.writeUIntLE(height - 1, 7, 3)
        vp8xChunk = { raw: makeChunk('VP8X', vp8xPayload) }
    }

    const body = Buffer.concat([
        Buffer.from('WEBP', 'ascii'),
        vp8xChunk.raw,
        ...rest.map(c => c.raw),
        exifChunk
    ])
    const out = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), body])
    out.writeUInt32LE(out.length - 8, 4)
    return out
}

export { writeExif, buildExifData }
