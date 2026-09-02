import { readFile } from 'fs/promises'
import { parseColor } from './color.js'
import { commandsToContours, fillContours } from './raster.js'

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

/** Scale a set of contours outward from their own bounding-box center, for a cheap stroke effect. */
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

    _fillContours(contours, colorInput) {
        const color = parseColor(colorInput)
        fillContours(this.data, this.width, this.height, contours, color)
    }

    rect({ x, y, width, height, radius = 0, fill, stroke, strokeWidth = 1 }) {
        const contours = commandsToContours(rectCommands(x, y, width, height, radius))
        if (stroke) {
            const so = strokeWidth / 2
            const strokeContours = commandsToContours(
                rectCommands(x - so, y - so, width + so * 2, height + so * 2, radius + so)
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
            const so = strokeWidth / 2
            const strokeContours = commandsToContours(ellipseCommands(x, y, rx + so, ry + so))
            this._fillContours(strokeContours, stroke)
        }
        if (fill) this._fillContours(contours, fill)
        return this
    }

    // Add to canvas.js - text() method with stroke support
    async text(str, { x, y, size = 24, color = '#000000', font, align = 'left', strokeColor, strokeWidth = 0 }) {
        if (!font) throw new Error('canvas.text() requires a font file path via { font }')
        const loadedFont = await loadFont(font)
    
        let drawX = x
        if (align === 'center' || align === 'right') {
            const width = loadedFont.getAdvanceWidth(str, size)
            drawX = align === 'center' ? x - width / 2 : x - width
        }
    
        const path = loadedFont.getPath(str, drawX, y, size)
        const contours = commandsToContours(path.commands)
    
        // Draw stroke outline first if specified
        if (strokeColor && strokeWidth > 0) {
            this._fillContours(offsetContours(contours, strokeWidth / 2), strokeColor)
        }
    
        // Then fill with main color
        this._fillContours(contours, color)
        return this
    }

    // ========== NEW METHODS ==========

    /**
     * gradient({ type: 'linear'|'radial', from, to, stops })
     */
    gradient({ type = 'linear', from = { x: 0, y: 0 }, to = { x: this.width, y: this.height }, stops = [] }) {
        const gradientStops = stops.map(s => ({
            ...parseColor(s.color),
            offset: Math.max(0, Math.min(1, s.offset))
        })).sort((a, b) => a.offset - b.offset)

        if (gradientStops.length === 0) {
            gradientStops.push({ r: 0, g: 0, b: 0, a: 1, offset: 0 })
            gradientStops.push({ r: 255, g: 255, b: 255, a: 1, offset: 1 })
        }

        if (type === 'radial') {
            const radius = typeof to === 'number' ? to : Math.max(this.width, this.height) / 2
            this._fillRadialGradient(from, radius, gradientStops)
        } else {
            this._fillLinearGradient(from, to, gradientStops)
        }
        return this
    }

    _fillLinearGradient(from, to, stops) {
        const dx = to.x - from.x
        const dy = to.y - from.y
        const lengthSq = dx * dx + dy * dy
        const ramp = this._buildGradientRamp(stops)

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const t = lengthSq > 0 ? ((x - from.x) * dx + (y - from.y) * dy) / lengthSq : 0
                const color = this._sampleRamp(ramp, t)
                const idx = (y * this.width + x) * 4
                this.data[idx] = color.r
                this.data[idx + 1] = color.g
                this.data[idx + 2] = color.b
                this.data[idx + 3] = Math.round(color.a * 255)
            }
        }
    }

    _fillRadialGradient(center, radius, stops) {
        const maxDist = radius || Math.max(this.width, this.height) / 2
        const ramp = this._buildGradientRamp(stops)
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const dist = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2)
                const t = Math.max(0, Math.min(1, dist / maxDist))
                const color = this._sampleRamp(ramp, t)
                const idx = (y * this.width + x) * 4
                this.data[idx] = color.r
                this.data[idx + 1] = color.g
                this.data[idx + 2] = color.b
                this.data[idx + 3] = Math.round(color.a * 255)
            }
        }
    }

    /** Precompute a fixed-resolution color ramp from gradient stops, once per gradient() call. */
    _buildGradientRamp(stops, steps = 256) {
        const ramp = new Array(steps + 1)
        for (let i = 0; i <= steps; i++) {
            ramp[i] = this._sampleGradient(i / steps, stops)
        }
        return ramp
    }

    _sampleRamp(ramp, t) {
        const clamped = t < 0 ? 0 : t > 1 ? 1 : t
        return ramp[Math.round(clamped * (ramp.length - 1))]
    }

    _sampleGradient(t, stops) {
        if (t <= stops[0].offset) return stops[0]
        if (t >= stops[stops.length - 1].offset) return stops[stops.length - 1]

        for (let i = 0; i < stops.length - 1; i++) {
            const s0 = stops[i]
            const s1 = stops[i + 1]
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

    /** line({ x1, y1, x2, y2, color, width = 1 }) */
    line({ x1, y1, x2, y2, color, width = 1 }) {
        const strokeColor = parseColor(color)
        const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1)
        const dx = (x2 - x1) / steps
        const dy = (y2 - y1) / steps

        for (let i = 0; i <= steps; i++) {
            const x = Math.round(x1 + dx * i)
            const y = Math.round(y1 + dy * i)
            
            if (width <= 1) {
                this._setPixel(x, y, strokeColor)
            } else {
                this.circle({ x, y, radius: width / 2, fill: color })
            }
        }
        return this
    }

    /** path({ commands, fill, stroke, strokeWidth }) */
    path({ commands, fill, stroke, strokeWidth = 1 }) {
        const contours = commandsToContours(commands)
        if (stroke) this._fillContours(offsetContours(contours, strokeWidth / 2), stroke)
        if (fill) this._fillContours(contours, fill)
        return this
    }

    /** arc({ x, y, radius, startAngle, endAngle, fill, stroke, strokeWidth }) */
    arc({ x, y, radius, startAngle = 0, endAngle = Math.PI * 2, fill, stroke, strokeWidth = 1 }) {
        const commands = []
        const segments = Math.max(8, Math.floor((endAngle - startAngle) * 16))
        
        commands.push({
            type: 'M',
            x: x + radius * Math.cos(startAngle),
            y: y + radius * Math.sin(startAngle)
        })

        for (let i = 1; i <= segments; i++) {
            const angle = startAngle + (endAngle - startAngle) * (i / segments)
            commands.push({
                type: 'L',
                x: x + radius * Math.cos(angle),
                y: y + radius * Math.sin(angle)
            })
        }

        commands.push({ type: 'Z' })

        const contours = commandsToContours(commands)
        if (stroke) this._fillContours(offsetContours(contours, strokeWidth / 2), stroke)
        if (fill) this._fillContours(contours, fill)
        return this
    }

    /** polygon({ points, fill, stroke, strokeWidth }) */
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

    /** triangle({ x1, y1, x2, y2, x3, y3, fill, stroke, strokeWidth }) */
    triangle({ x1, y1, x2, y2, x3, y3, fill, stroke, strokeWidth = 1 }) {
        return this.polygon({
            points: [{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }],
            fill,
            stroke,
            strokeWidth
        })
    }

    /** star({ x, y, points = 5, outerRadius, innerRadius, fill, stroke, strokeWidth }) */
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

    /** textBg(str, { x, y, size, color, font, align, bg, bgPadding, borderRadius }) */
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