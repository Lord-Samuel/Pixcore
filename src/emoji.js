import { readFileSync } from 'fs'

function u16(buf, o) { return buf.readUInt16BE(o) }
function i16(buf, o) { return buf.readInt16BE(o) }
function u32(buf, o) { return buf.readUInt32BE(o) }

/** Parse a cmap table, returning a codepoint -> glyphIndex lookup function.
 *  Prefers a format-12 subtable (segmented coverage, supports the full
 *  Unicode range including astral-plane emoji); falls back to format 4
 *  (BMP-only) if that's all the font provides. */
function parseCmapLookup(buf, cmapOffset) {
    const numSubtables = u16(buf, cmapOffset + 2)
    let format12Offset = null
    let format4Offset = null
    for (let i = 0; i < numSubtables; i++) {
        const rec = cmapOffset + 4 + i * 8
        const offset = cmapOffset + u32(buf, rec + 4)
        const format = u16(buf, offset)
        if (format === 12) format12Offset = offset
        else if (format === 4 && format4Offset === null) format4Offset = offset
    }

    if (format12Offset !== null) {
        const subOff = format12Offset
        const numGroups = u32(buf, subOff + 12)
        return (codepoint) => {
            // Groups are sorted by startCharCode in a well-formed font; linear
            // scan is fine here since emoji lookups are not a hot path (a
            // handful of characters per text() call, not per-pixel work).
            for (let i = 0; i < numGroups; i++) {
                const rec = subOff + 16 + i * 12
                const start = u32(buf, rec)
                const end = u32(buf, rec + 4)
                if (codepoint >= start && codepoint <= end) {
                    return u32(buf, rec + 8) + (codepoint - start)
                }
                if (start > codepoint) break
            }
            return 0
        }
    }

    if (format4Offset !== null) {
        const off = format4Offset
        const segCountX2 = u16(buf, off + 6)
        const segCount = segCountX2 / 2
        const endCodesOff = off + 14
        const startCodesOff = endCodesOff + segCountX2 + 2
        const idDeltaOff = startCodesOff + segCountX2
        const idRangeOff = idDeltaOff + segCountX2
        return (codepoint) => {
            if (codepoint > 0xFFFF) return 0 // format 4 can't represent astral codepoints
            for (let s = 0; s < segCount; s++) {
                const endCode = u16(buf, endCodesOff + s * 2)
                if (codepoint <= endCode) {
                    const startCode = u16(buf, startCodesOff + s * 2)
                    if (codepoint < startCode) return 0
                    const idDelta = i16(buf, idDeltaOff + s * 2)
                    const idRangeOffset = u16(buf, idRangeOff + s * 2)
                    if (idRangeOffset === 0) return (codepoint + idDelta) & 0xFFFF
                    const addr = idRangeOff + s * 2 + idRangeOffset + (codepoint - startCode) * 2
                    const gid = u16(buf, addr)
                    return gid === 0 ? 0 : (gid + idDelta) & 0xFFFF
                }
            }
            return 0
        }
    }

    return () => 0
}

/**
 * Parse a color bitmap emoji font (CBDT/CBLC tables — e.g. Noto Color Emoji).
 * These fonts have no vector outlines; every glyph is an embedded PNG image.
 * Returns { getGlyphImage(codepoint) } which resolves a Unicode codepoint to
 * { pngBuffer, width, height, bearingX, bearingY, advance } or null.
 */
function parseColorBitmapFont(buf) {
    const numTables = u16(buf, 4)
    const tables = {}
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16
        const tag = buf.toString('ascii', rec, rec + 4)
        tables[tag] = { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) }
    }
    if (!tables.CBLC || !tables.CBDT || !tables.cmap) {
        throw new Error('emojiFont: not a color bitmap font (missing cmap/CBLC/CBDT tables) — ' +
            'a vector text font was passed where a color emoji font (e.g. Noto Color Emoji) was expected')
    }

    const codepointToGlyphIndex = parseCmapLookup(buf, tables.cmap.offset)
    const cblcOff = tables.CBLC.offset
    const cbdtOff = tables.CBDT.offset
    const numSizes = u32(buf, cblcOff + 4)

    function findIndexSubTable(glyphIndex) {
        for (let s = 0; s < numSizes; s++) {
            const rec = cblcOff + 8 + s * 48
            const subArrayOffset = u32(buf, rec)
            const numSubTables = u32(buf, rec + 8)
            const ppemX = buf.readUInt8(rec + 44)
            const ppemY = buf.readUInt8(rec + 45)
            const subArrayBase = cblcOff + subArrayOffset
            for (let i = 0; i < numSubTables; i++) {
                const entryOff = subArrayBase + i * 8
                const first = u16(buf, entryOff)
                const last = u16(buf, entryOff + 2)
                if (glyphIndex >= first && glyphIndex <= last) {
                    const additionalOffset = u32(buf, entryOff + 4)
                    return { subTableOff: subArrayBase + additionalOffset, first, last, ppemX, ppemY }
                }
            }
        }
        return null
    }

    const glyphCache = new Map()
    function getGlyphImage(codepoint) {
        if (glyphCache.has(codepoint)) return glyphCache.get(codepoint)
        const result = computeGlyphImage(codepoint)
        glyphCache.set(codepoint, result)
        return result
    }

    function computeGlyphImage(codepoint) {
        const gid = codepointToGlyphIndex(codepoint)
        if (gid === 0) return null

        const location = findIndexSubTable(gid)
        if (!location) return null

        const indexFormat = u16(buf, location.subTableOff)
        const imageFormat = u16(buf, location.subTableOff + 2)
        const imageDataOffset = u32(buf, location.subTableOff + 4)

        let glyphOffset, glyphLength
        if (indexFormat === 1) {
            const offsetArrayBase = location.subTableOff + 8
            const localIdx = gid - location.first
            const off0 = u32(buf, offsetArrayBase + localIdx * 4)
            const off1 = u32(buf, offsetArrayBase + (localIdx + 1) * 4)
            glyphOffset = cbdtOff + imageDataOffset + off0
            glyphLength = off1 - off0
        } else if (indexFormat === 2) {
            // All glyphs in this range have the same fixed length.
            const imageSize = u32(buf, location.subTableOff + 8)
            const localIdx = gid - location.first
            glyphOffset = cbdtOff + imageDataOffset + localIdx * imageSize
            glyphLength = imageSize
        } else {
            throw new Error(`emojiFont: unsupported CBLC indexFormat ${indexFormat} (only 1 and 2 are implemented)`)
        }

        if (glyphLength <= 0) return null // e.g. space or other glyph with no bitmap

        if (imageFormat === 17) {
            // SmallGlyphMetrics (5 bytes) + uint32 dataLen + PNG data
            const height = buf.readUInt8(glyphOffset)
            const width = buf.readUInt8(glyphOffset + 1)
            const bearingX = buf.readInt8(glyphOffset + 2)
            const bearingY = buf.readInt8(glyphOffset + 3)
            const advance = buf.readUInt8(glyphOffset + 4)
            const dataLen = u32(buf, glyphOffset + 5)
            const pngBuffer = buf.subarray(glyphOffset + 9, glyphOffset + 9 + dataLen)
            return { pngBuffer, width, height, bearingX, bearingY, advance, ppemX: location.ppemX, ppemY: location.ppemY }
        }
        if (imageFormat === 19) {
            // BigGlyphMetrics (8 bytes) + uint32 dataLen + PNG data
            const height = buf.readUInt8(glyphOffset)
            const width = buf.readUInt8(glyphOffset + 1)
            const bearingX = buf.readInt8(glyphOffset + 2)
            const bearingY = buf.readInt8(glyphOffset + 3)
            const advance = buf.readUInt8(glyphOffset + 4)
            // bytes 5-7: vertical bearing/advance, unused here
            const dataLen = u32(buf, glyphOffset + 8)
            const pngBuffer = buf.subarray(glyphOffset + 12, glyphOffset + 12 + dataLen)
            return { pngBuffer, width, height, bearingX, bearingY, advance, ppemX: location.ppemX, ppemY: location.ppemY }
        }
        throw new Error(`emojiFont: unsupported CBDT imageFormat ${imageFormat} (only 17 and 19 are implemented)`)
    }

    return { getGlyphImage }
}

const emojiFontCache = new Map()
function loadColorBitmapFont(path) {
    if (emojiFontCache.has(path)) return emojiFontCache.get(path)
    const buf = readFileSync(path)
    const font = parseColorBitmapFont(buf)
    emojiFontCache.set(path, font)
    return font
}

export { parseColorBitmapFont, loadColorBitmapFont }
