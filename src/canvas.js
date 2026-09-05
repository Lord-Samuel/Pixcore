import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { parseColor } from './color.js'
import { commandsToContours, fillContours } from './raster.js'
import { loadColorBitmapFont } from './emoji.js'
import { composite, resizeSmooth } from './ops.js'

// Bundled color emoji font (CBDT/CBLC format), used as the default emojiFont
// so canvas.text() renders emoji out of the box with no setup required.
const BUNDLED_EMOJI_FONT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'font', 'NotoColorEmoji-Ed.ttf')

// Decoded+scaled emoji bitmaps are cached by (font path, codepoint, size):
// decoding the embedded PNG and resizing it is the expensive part of drawing
// an emoji glyph, and the same emoji at the same text size is commonly
// reused many times. Safe to share the cached image across draws since
// ops.composite() only ever reads its overlay argument, never mutates it.
const emojiBitmapCache = new WeakMap()

let opentypeMod = null
async function getOpentype() {
    if (opentypeMod !== null) return opentypeMod
    let mod
    try {
        mod = await import('opentype.js')
    } catch {
        throw new Error('Text rendering requires the optional "opentype.js" package: npm install opentype.js')
    }
    const resolved = typeof mod.parse === 'function' ? mod : mod.default
    if (!resolved || typeof resolved.parse !== 'function') {
        throw new Error('Text rendering: could not find opentype.parse on the "opentype.js" module (unexpected module shape)')
    }
    opentypeMod = resolved
    return opentypeMod
}

const fontCache = new Map()
async function loadFont(path) {
    if (fontCache.has(path)) return fontCache.get(path)
    const opentype = await getOpentype()
    const buffer = await readFile(path)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const font = opentype.parse(arrayBuffer)
    fontCache.set(path, font)
    return font
}

/** Build a rounded-rect (or plain rect, radius=0) as path commands. */
function rectCommands(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2)
    if (r <= 0) {
        return [
            { type: 'M', x, y },
            { type: 'L', x: x + width, y },
            { type: 'L', x: x + width, y: y + height },
            { type: 'L', x, y: y + height },
            { type: 'Z' }
        ]
    }
    const k = r * 0.5523
    return [
        { type: 'M', x: x + r, y },
        { type: 'L', x: x + width - r, y },
        { type: 'C', x1: x + width - r + k, y1: y, x2: x + width, y2: y + r - k, x: x + width, y: y + r },
        { type: 'L', x: x + width, y: y + height - r },
        { type: 'C', x1: x + width, y1: y + height - r + k, x2: x + width - r + k, y2: y + height, x: x + width - r, y: y + height },
        { type: 'L', x: x + r, y: y + height },
        { type: 'C', x1: x + r - k, y1: y + height, x2: x, y2: y + height - r + k, x, y: y + height - r },
        { type: 'L', x, y: y + r },
        { type: 'C', x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y },
        { type: 'Z' }
    ]
}

/** Build an ellipse (circle when rx===ry) as path commands, centered at (cx,cy). */
function ellipseCommands(cx, cy, rx, ry) {
    const kx = rx * 0.5523, ky = ry * 0.5523
    return [
        { type: 'M', x: cx + rx, y: cy },
        { type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
        { type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
        { type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
        { type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
        { type: 'Z' }
    ]
}

/** Normalize/sort gradient stops, parsing each color and clamping offsets to [0,1]. */
function normalizeStops(stops) {
    const parsed = stops
        .map(s => ({ ...parseColor(s.color), offset: Math.max(0, Math.min(1, s.offset)) }))
        .sort((a, b) => a.offset - b.offset)
    if (parsed.length === 0) {
        parsed.push({ r: 0, g: 0, b: 0, a: 1, offset: 0 })
        parsed.push({ r: 255, g: 255, b: 255, a: 1, offset: 1 })
    }
    return parsed
}

function sampleGradientAt(t, stops) {
    if (t <= stops[0].offset) return stops[0]
    if (t >= stops[stops.length - 1].offset) return stops[stops.length - 1]
    for (let i = 0; i < stops.length - 1; i++) {
        const s0 = stops[i], s1 = stops[i + 1]
        if (t >= s0.offset && t <= s1.offset) {
            const localT = (t - s0.offset) / (s1.offset - s0.offset)
            return {
                r: Math.round(s0.r + (s1.r - s0.r) * localT),
                g: Math.round(s0.g + (s1.g - s0.g) * localT),
                b: Math.round(s0.b + (s1.b - s0.b) * localT),
                a: s0.a + (s1.a - s0.a) * localT
            }
        }
    }
    return stops[stops.length - 1]
}

/** Precompute a fixed-resolution color ramp from gradient stops, once per fill. */
function buildGradientRamp(stops, steps = 256) {
    const ramp = new Array(steps + 1)
    for (let i = 0; i <= steps; i++) ramp[i] = sampleGradientAt(i / steps, stops)
    return ramp
}

function sampleRamp(ramp, t) {
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t
    return ramp[Math.round(clamped * (ramp.length - 1))]
}

/**
 * Build a (x,y) => {r,g,b,a} sampler function from a gradient descriptor.
 * canvasWidth/canvasHeight are only used as fallback defaults for `to` when
 * the caller doesn't specify one explicitly (matches whole-canvas gradient()).
 */
function makeGradientSampler({ type = 'linear', from = { x: 0, y: 0 }, to, stops = [] }, canvasWidth, canvasHeight) {
    const ramp = buildGradientRamp(normalizeStops(stops))

    if (type === 'radial') {
        const radius = typeof to === 'number' ? to : Math.max(canvasWidth, canvasHeight) / 2
        return (x, y) => {
            const dist = Math.hypot(x - from.x, y - from.y)
            const t = radius > 0 ? dist / radius : 0
            return sampleRamp(ramp, t)
        }
    }

    const target = to && typeof to === 'object' ? to : { x: canvasWidth, y: canvasHeight }
    const dx = target.x - from.x, dy = target.y - from.y
    const lengthSq = dx * dx + dy * dy
    return (x, y) => {
        const t = lengthSq > 0 ? ((x - from.x) * dx + (y - from.y) * dy) / lengthSq : 0
        return sampleRamp(ramp, t)
    }
}

function isGradientDescriptor(input) {
    return input && typeof input === 'object' && (input.type === 'linear' || input.type === 'radial')
}
function offsetContours(contours, amount) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const ring of contours) for (const p of ring) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    const w = maxX - minX, h = maxY - minY
    const sx = w > 0 ? (w + amount * 2) / w : 1
    const sy = h > 0 ? (h + amount * 2) / h : 1
    return contours.map(ring => ring.map(p => ({
        x: cx + (p.x - cx) * sx,
        y: cy + (p.y - cy) * sy
    })))
}

class Canvas {
    constructor(width, height, { background } = {}) {
        this.width = width
        this.height = height
        this.data = new Uint8Array(width * height * 4)
        if (background) {
            const color = parseColor(background)
            for (let i = 0; i < this.data.length; i += 4) {
                this.data[i] = color.r
                this.data[i + 1] = color.g
                this.data[i + 2] = color.b
                this.data[i + 3] = Math.round(color.a * 255)
            }
        }
    }

    /**
     * fill: either a CSS-style color string/object, OR a gradient descriptor
     * { type: 'linear'|'radial', from, to, stops } to clip a gradient to
     * this shape's contours.
     */
    _fillContours(contours, fillInput) {
        if (isGradientDescriptor(fillInput)) {
            const sampler = makeGradientSampler(fillInput, this.width, this.height)
            fillContours(this.data, this.width, this.height, contours, sampler)
        } else {
            const color = parseColor(fillInput)
            fillContours(this.data, this.width, this.height, contours, color)
        }
    }

    rect({ x, y, width, height, radius = 0, fill, stroke, strokeWidth = 1 }) {
        const contours = commandsToContours(rectCommands(x, y, width, height, radius))
        if (stroke) {
            // Full strokeWidth expansion, stroke sits outside the shape.
            const strokeContours = commandsToContours(
                rectCommands(x - strokeWidth, y - strokeWidth, width + strokeWidth * 2, height + strokeWidth * 2, radius + strokeWidth)
            )
            this._fillContours(strokeContours, stroke)
        }
        if (fill) this._fillContours(contours, fill)
        return this
    }

    circle({ x, y, radius, fill, stroke, strokeWidth = 1 }) {
        return this.ellipse({ x, y, rx: radius, ry: radius, fill, stroke, strokeWidth })
    }

    ellipse({ x, y, rx, ry, fill, stroke, strokeWidth = 1 }) {
        const contours = commandsToContours(ellipseCommands(x, y, rx, ry))
        if (stroke) {
            // Full strokeWidth expansion, stroke sits outside the shape.
            const strokeContours = commandsToContours(ellipseCommands(x, y, rx + strokeWidth, ry + strokeWidth))
            this._fillContours(strokeContours, stroke)
        }
        if (fill) this._fillContours(contours, fill)
        return this
    }

    /**
     * text(str, { x, y, size, color, font, align, strokeColor, strokeWidth, emojiFont, colorFont })
     * x,y is the baseline origin (left edge for align:'left', the default).
     * font: path to a .ttf/.otf file. Requires the optional "opentype.js" package.
     *
     * Two different color-emoji font formats exist and need different handling:
     *   colorFont: a COLR/CPAL font (e.g. the Noto Color Emoji build from
     *     Google Fonts) — layered vector glyphs with palette colors. Rendered
     *     directly via opentype.js's native getPaths()/charToGlyph() support,
     *     no raster step involved. No default; pass this if you have one.
     *   emojiFont: a CBDT/CBLC bitmap font (e.g. the classic Android Noto
     *     Color Emoji build) — every glyph is an embedded PNG, decoded and
     *     composited as an image. Defaults to a bundled copy of this format,
     *     so emoji render out of the box even with no options at all.
     * Regular text fonts have no emoji glyphs in either format — without one
     * of the above resolving a given emoji, it's skipped (with a
     * console.warn) rather than silently producing nothing unexplained.
     * colorFont is tried first; emojiFont is the fallback for characters it
     * doesn't cover.
     */
    async text(str, { x, y, size = 24, color = '#000000', font, align = 'left', strokeColor, strokeWidth = 0, emojiFont = BUNDLED_EMOJI_FONT, colorFont } = {}) {
        if (!font) throw new Error('canvas.text() requires a font file path via { font }')
        const loadedFont = await loadFont(font)
        const colorFontObj = colorFont ? await loadFont(colorFont) : null
        const bitmapFont = emojiFont ? loadColorBitmapFont(emojiFont) : null

        // Keycap-base characters exist in emoji fonts' cmaps only to support
        // keycap sequences (digit + U+20E3 -> 1️⃣), which isn't composed here
        // (same class of limitation as flags/ZWJ). A bare '5', '#', or '*' in
        // normal text must never be hijacked into a tiny colored glyph.
        const KEYCAP_BASES = new Set([0x23, 0x2A, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39])

        // Partition into runs: consecutive plain codepoints are batched into
        // one run (preserves kerning/shaping within it); each resolved emoji
        // codepoint (via either color-font format) is its own run.
        const runs = []
        let currentText = ''
        for (const ch of str) { // for...of a string iterates by codepoint, handling surrogate pairs correctly
            const codepoint = ch.codePointAt(0)
            const isKeycapBase = KEYCAP_BASES.has(codepoint)
            const colorGlyph = (!isKeycapBase && colorFontObj) ? colorFontObj.charToGlyph(ch) : null
            const bitmapGlyph = (!isKeycapBase && !colorGlyph && bitmapFont) ? bitmapFont.getGlyphImage(codepoint) : null

            if (colorGlyph && colorGlyph.index > 0) {
                if (currentText) { runs.push({ type: 'text', str: currentText }); currentText = '' }
                runs.push({ type: 'colr', char: ch })
            } else if (bitmapGlyph) {
                if (currentText) { runs.push({ type: 'text', str: currentText }); currentText = '' }
                runs.push({ type: 'emoji', glyph: bitmapGlyph })
            } else {
                if (codepoint > 0xFFFF && !colorFontObj && !bitmapFont) {
                    console.warn(`canvas.text(): "${ch}" (U+${codepoint.toString(16).toUpperCase()}) has no glyph in a typical text font and no colorFont/emojiFont was provided — it will not render.`)
                }
                currentText += ch
            }
        }
        if (currentText) runs.push({ type: 'text', str: currentText })

        // Measure total width across all runs for alignment.
        let totalWidth = 0
        for (const run of runs) {
            if (run.type === 'text') totalWidth += loadedFont.getAdvanceWidth(run.str, size)
            else if (run.type === 'colr') totalWidth += colorFontObj.getAdvanceWidth(run.char, size)
            else totalWidth += (run.glyph.advance / run.glyph.ppemY) * size
        }

        let cursorX = x
        if (align === 'center') cursorX = x - totalWidth / 2
        else if (align === 'right') cursorX = x - totalWidth

        for (const run of runs) {
            if (run.type === 'text') {
                const path = loadedFont.getPath(run.str, cursorX, y, size)
                const contours = commandsToContours(path.commands)
                if (strokeColor && strokeWidth > 0) this._fillContours(offsetContours(contours, strokeWidth / 2), strokeColor)
                this._fillContours(contours, color)
                cursorX += loadedFont.getAdvanceWidth(run.str, size)
            } else if (run.type === 'colr') {
                const paths = colorFontObj.getPaths(run.char, cursorX, y, size, { fill: color })
                for (const path of paths) {
                    this._fillContours(commandsToContours(path.commands), path.fill || color)
                }
                cursorX += colorFontObj.getAdvanceWidth(run.char, size)
            } else {
                cursorX += await this._drawEmojiGlyph(run.glyph, cursorX, y, size)
            }
        }
        return this
    }

    /** Decode + scale + composite one emoji bitmap glyph; returns its scaled advance width. */
    async _drawEmojiGlyph(glyph, cursorX, y, size) {
        const scale = size / glyph.ppemY

        let sizeCache = emojiBitmapCache.get(glyph)
        if (!sizeCache) { sizeCache = new Map(); emojiBitmapCache.set(glyph, sizeCache) }

        let resized = sizeCache.get(size)
        if (!resized) {
            const { decode } = await import('./decode.js') // lazy: keeps canvas.js shape-only usage free of the pngjs/jpeg-js/webp dependency chain
            const decoded = await decode(Buffer.from(glyph.pngBuffer))
            const scaledW = Math.max(1, Math.round(decoded.width * scale))
            const scaledH = Math.max(1, Math.round(decoded.height * scale))
            resized = (scaledW === decoded.width && scaledH === decoded.height)
                ? decoded
                : resizeSmooth(decoded, scaledW, scaledH)
            sizeCache.set(size, resized)
        }

        const left = Math.round(cursorX + glyph.bearingX * scale)
        const top = Math.round(y - glyph.bearingY * scale)
        const result = composite({ data: this.data, width: this.width, height: this.height }, resized, { left, top })
        this.data = result.data

        return glyph.advance * scale
    }

    gradient({ type = 'linear', from = { x: 0, y: 0 }, to, stops = [] } = {}) {
        const sampler = makeGradientSampler({ type, from, to, stops }, this.width, this.height)
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const color = sampler(x, y)
                const idx = (y * this.width + x) * 4
                this.data[idx] = color.r
                this.data[idx + 1] = color.g
                this.data[idx + 2] = color.b
                this.data[idx + 3] = Math.round(color.a * 255)
            }
        }
        return this
    }

    line({ x1, y1, x2, y2, color, width = 1 }) {
        const dx = x2 - x1, dy = y2 - y1
        const len = Math.hypot(dx, dy)
        const half = width / 2
        const nx = len > 0 ? (-dy / len) * half : half
        const ny = len > 0 ? (dx / len) * half : 0
        const commands = [
            { type: 'M', x: x1 + nx, y: y1 + ny },
            { type: 'L', x: x2 + nx, y: y2 + ny },
            { type: 'L', x: x2 - nx, y: y2 - ny },
            { type: 'L', x: x1 - nx, y: y1 - ny },
            { type: 'Z' }
        ]
        this._fillContours(commandsToContours(commands), color)
        return this
    }

    path({ commands, fill, stroke, strokeWidth = 1 }) {
        const contours = commandsToContours(commands)
        if (stroke) this._fillContours(offsetContours(contours, strokeWidth / 2), stroke)
        if (fill) this._fillContours(contours, fill)
        return this
    }

    arc({ x, y, radius, startAngle = 0, endAngle = Math.PI * 2, fill, stroke, strokeWidth = 1 }) {
        const sweep = Math.abs(endAngle - startAngle)
        const isFullCircle = sweep >= Math.PI * 2 - 1e-9
        const segments = Math.max(8, Math.floor(sweep * 16))
        const commands = []

        // Partial arcs get a pie-wedge shape (path through the center), the
        // usual meaning of a filled arc. A full circle skips the center.
        if (!isFullCircle) {
            commands.push({ type: 'M', x, y })
            commands.push({ type: 'L', x: x + radius * Math.cos(startAngle), y: y + radius * Math.sin(startAngle) })
        } else {
            commands.push({ type: 'M', x: x + radius * Math.cos(startAngle), y: y + radius * Math.sin(startAngle) })
        }

        for (let i = 1; i <= segments; i++) {
            const angle = startAngle + (endAngle - startAngle) * (i / segments)
            commands.push({ type: 'L', x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) })
        }

        commands.push({ type: 'Z' })

        const contours = commandsToContours(commands)
        if (stroke) this._fillContours(offsetContours(contours, strokeWidth / 2), stroke)
        if (fill) this._fillContours(contours, fill)
        return this
    }

    polygon({ points, fill, stroke, strokeWidth = 1 }) {
        if (!points || points.length < 3) return this
        const commands = [
            { type: 'M', x: points[0].x, y: points[0].y },
            ...points.slice(1).map(p => ({ type: 'L', x: p.x, y: p.y })),
            { type: 'Z' }
        ]
        const contours = commandsToContours(commands)
        if (stroke) this._fillContours(offsetContours(contours, strokeWidth / 2), stroke)
        if (fill) this._fillContours(contours, fill)
        return this
    }

    triangle({ x1, y1, x2, y2, x3, y3, fill, stroke, strokeWidth = 1 }) {
        return this.polygon({
            points: [{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }],
            fill,
            stroke,
            strokeWidth
        })
    }

    star({ x, y, points = 5, outerRadius, innerRadius = outerRadius * 0.5, fill, stroke, strokeWidth = 1 }) {
        const vertices = []
        for (let i = 0; i < points * 2; i++) {
            const angle = (i * Math.PI) / points
            const radius = i % 2 === 0 ? outerRadius : innerRadius
            vertices.push({
                x: x + radius * Math.cos(angle),
                y: y + radius * Math.sin(angle)
            })
        }
        return this.polygon({ points: vertices, fill, stroke, strokeWidth })
    }

    async textBg(str, { x, y, size = 24, color = '#000000', font, align = 'left', bg = 'rgba(0,0,0,0.5)', bgPadding = 10, borderRadius = 6 }) {
        if (!font) throw new Error('canvas.textBg() requires a font file path via { font }')
        const loadedFont = await loadFont(font)

        let drawX = x
        let textWidth = loadedFont.getAdvanceWidth(str, size)

        if (align === 'center') {
            drawX = x - textWidth / 2
        } else if (align === 'right') {
            drawX = x - textWidth
        }

        this.rect({
            x: drawX - bgPadding,
            y: y - size - bgPadding,
            width: textWidth + bgPadding * 2,
            height: size + bgPadding * 2,
            radius: borderRadius,
            fill: bg
        })

        await this.text(str, { x: drawX, y, size, color, font, align: 'left' })
        return this
    }

    _setPixel(x, y, color) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return
        const idx = (y * this.width + x) * 4
        const a = color.a
        if (a >= 1) {
            this.data[idx] = color.r
            this.data[idx + 1] = color.g
            this.data[idx + 2] = color.b
            this.data[idx + 3] = 255
        } else {
            const dstA = this.data[idx + 3] / 255
            const outA = a + dstA * (1 - a)
            if (outA === 0) {
                this.data[idx] = this.data[idx + 1] = this.data[idx + 2] = 0
            } else {
                this.data[idx] = Math.round((color.r * a + this.data[idx] * dstA * (1 - a)) / outA)
                this.data[idx + 1] = Math.round((color.g * a + this.data[idx + 1] * dstA * (1 - a)) / outA)
                this.data[idx + 2] = Math.round((color.b * a + this.data[idx + 2] * dstA * (1 - a)) / outA)
            }
            this.data[idx + 3] = Math.round(outA * 255)
        }
    }

    toImage() {
        return {
            data: this.data,
            width: this.width,
            height: this.height,
            format: 'raw',
            originalSize: this.data.length
        }
    }
}

function createCanvas(width, height, opts = {}) {
    return new Canvas(width, height, opts)
}

export { createCanvas, Canvas }
