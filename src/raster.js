/**
 * Shared rasterization core for the canvas API. Everything the canvas draws
 * (rects, circles, rounded corners, glyph outlines) reduces to one or more
 * closed polygon contours, flattened from any curves, then filled with a
 * nonzero-winding-rule scanline fill. Keeping this in one place means rects,
 * circles, and text all get identical, identically-tested fill behavior.
 */

/** Flatten a cubic bezier into line segments, appended to `out` (excludes p0). */
function flattenCubic(out, p0, p1, p2, p3, segments = 16) {
    for (let i = 1; i <= segments; i++) {
        const t = i / segments
        const mt = 1 - t
        const a = mt * mt * mt
        const b = 3 * mt * mt * t
        const c = 3 * mt * t * t
        const d = t * t * t
        out.push({
            x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
            y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
        })
    }
}

/** Flatten a quadratic bezier into line segments, appended to `out` (excludes p0). */
function flattenQuadratic(out, p0, p1, p2, segments = 12) {
    for (let i = 1; i <= segments; i++) {
        const t = i / segments
        const mt = 1 - t
        const a = mt * mt
        const b = 2 * mt * t
        const c = t * t
        out.push({
            x: a * p0.x + b * p1.x + c * p2.x,
            y: a * p0.y + b * p1.y + c * p2.y
        })
    }
}

/**
 * Convert a path command list (the same shape opentype.js produces, and
 * which canvas.js also builds by hand for rects/circles) into flattened
 * polygon contours: an array of rings, each an array of {x,y} points.
 * Commands: M (move/new contour), L (line), C (cubic), Q (quadratic), Z (close).
 */
function commandsToContours(commands) {
    const contours = []
    let current = null
    let cursor = { x: 0, y: 0 }
    let start = { x: 0, y: 0 }

    for (const cmd of commands) {
        if (cmd.type === 'M') {
            current = []
            contours.push(current)
            cursor = { x: cmd.x, y: cmd.y }
            start = cursor
            current.push({ ...cursor })
        } else if (cmd.type === 'L') {
            if (!current) { current = []; contours.push(current); current.push({ ...cursor }) }
            cursor = { x: cmd.x, y: cmd.y }
            current.push({ ...cursor })
        } else if (cmd.type === 'C') {
            if (!current) { current = []; contours.push(current); current.push({ ...cursor }) }
            const p1 = { x: cmd.x1, y: cmd.y1 }
            const p2 = { x: cmd.x2, y: cmd.y2 }
            const p3 = { x: cmd.x, y: cmd.y }
            flattenCubic(current, cursor, p1, p2, p3)
            cursor = p3
        } else if (cmd.type === 'Q') {
            if (!current) { current = []; contours.push(current); current.push({ ...cursor }) }
            const p1 = { x: cmd.x1, y: cmd.y1 }
            const p2 = { x: cmd.x, y: cmd.y }
            flattenQuadratic(current, cursor, p1, p2)
            cursor = p2
        } else if (cmd.type === 'Z') {
            if (current && current.length) {
                const last = current[current.length - 1]
                if (last.x !== start.x || last.y !== start.y) current.push({ ...start })
            }
            cursor = start
        }
    }
    return contours.filter(c => c.length >= 2)
}

/**
 * Fill a set of polygon contours into an RGBA buffer using the nonzero
 * winding rule (so e.g. a letter "O" — outer ring + inner ring wound
 * opposite directions — correctly renders as a ring with a hole).
 * color: {r,g,b,a} with a in [0,1]. Blends via standard "source over".
 */
function fillContours(buffer, width, height, contours, color) {
    if (!contours.length || color.a <= 0) return

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const ring of contours) {
        for (const p of ring) {
            if (p.x < minX) minX = p.x
            if (p.x > maxX) maxX = p.x
            if (p.y < minY) minY = p.y
            if (p.y > maxY) maxY = p.y
        }
    }
    const yStart = Math.max(0, Math.floor(minY))
    const yEnd = Math.min(height - 1, Math.ceil(maxY))
    const xStart = Math.max(0, Math.floor(minX))
    const xEnd = Math.min(width - 1, Math.ceil(maxX))
    if (yEnd < yStart || xEnd < xStart) return
    const boxW = xEnd - xStart + 1
    const boxH = yEnd - yStart + 1

    // Multi-sample vertical coverage: sample N sublines per pixel row
    const VERTICAL_SAMPLES = 4
    const ySamples = []
    for (let i = 0; i < VERTICAL_SAMPLES; i++) {
        ySamples.push((i + 0.5) / VERTICAL_SAMPLES)
    }

    // Accumulate coverage into a buffer sized to the shape's bounding box
    // only (not the whole canvas) — shapes are typically much smaller than
    // the canvas they're drawn on, so this avoids an O(width*height)
    // allocation and scan per fill call.
    const coverageBuffer = new Float32Array(boxW * boxH)

    for (let y = yStart; y <= yEnd; y++) {
        for (const yOffset of ySamples) {
            const scanY = y + yOffset // sample at sub-pixel positions
            
            // Collect (x, winding direction) crossings of this scanline across all rings.
            const crossings = []
            for (const ring of contours) {
                for (let i = 0; i < ring.length - 1; i++) {
                    const a = ring[i], b = ring[i + 1]
                    if (a.y === b.y) continue
                    const yMin = Math.min(a.y, b.y), yMax = Math.max(a.y, b.y)
                    if (scanY < yMin || scanY >= yMax) continue
                    const t = (scanY - a.y) / (b.y - a.y)
                    const x = a.x + t * (b.x - a.x)
                    crossings.push({ x, dir: b.y > a.y ? 1 : -1 })
                }
            }
            if (!crossings.length) continue
            crossings.sort((c1, c2) => c1.x - c2.x)

            let winding = 0
            let spanStart = null
            for (const crossing of crossings) {
                const wasInside = winding !== 0
                winding += crossing.dir
                const isInside = winding !== 0
                if (!wasInside && isInside) {
                    spanStart = crossing.x
                } else if (wasInside && !isInside && spanStart !== null) {
                    // Accumulate coverage for this span into the float buffer
                    accumulateSpan(coverageBuffer, boxW, boxH, xStart, yStart, y, spanStart, crossing.x, 1 / VERTICAL_SAMPLES)
                    spanStart = null
                }
            }
        }
    }

    // Blend once per pixel using accumulated coverage
    for (let y = yStart; y <= yEnd; y++) {
        const rowBase = (y - yStart) * boxW
        for (let x = xStart; x <= xEnd; x++) {
            const coverage = coverageBuffer[rowBase + (x - xStart)]
            if (coverage <= 0) continue
            blendPixel(buffer, width, x, y, color, coverage)
        }
    }
}

/** Accumulate horizontal coverage into the (bbox-local) float buffer, with fractional edge coverage. */
function accumulateSpan(buffer, boxW, boxH, xStart, yStart, y, x0, x1, weight) {
    const localY = y - yStart
    if (localY < 0 || localY >= boxH) return
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t }
    const spanXStart = Math.max(xStart, Math.floor(x0))
    const spanXEnd = Math.min(xStart + boxW - 1, Math.ceil(x1) - 1)
    const rowBase = localY * boxW
    for (let x = spanXStart; x <= spanXEnd; x++) {
        const left = Math.max(x, x0)
        const right = Math.min(x + 1, x1)
        const horizontalCoverage = Math.max(0, right - left)
        if (horizontalCoverage <= 0) continue
        buffer[rowBase + (x - xStart)] += horizontalCoverage * weight
    }
}

/** Standard "source over" compositing of one pixel, with an extra coverage multiplier for AA. */
function blendPixel(buffer, width, x, y, color, coverage = 1) {
    const idx = (y * width + x) * 4
    const srcA = color.a * coverage
    if (srcA <= 0) return
    if (srcA >= 1) {
        buffer[idx] = color.r
        buffer[idx + 1] = color.g
        buffer[idx + 2] = color.b
        buffer[idx + 3] = 255
        return
    }
    const dstA = buffer[idx + 3] / 255
    const outA = srcA + dstA * (1 - srcA)
    if (outA === 0) {
        buffer[idx] = buffer[idx + 1] = buffer[idx + 2] = 0
    } else {
        buffer[idx] = Math.round((color.r * srcA + buffer[idx] * dstA * (1 - srcA)) / outA)
        buffer[idx + 1] = Math.round((color.g * srcA + buffer[idx + 1] * dstA * (1 - srcA)) / outA)
        buffer[idx + 2] = Math.round((color.b * srcA + buffer[idx + 2] * dstA * (1 - srcA)) / outA)
    }
    buffer[idx + 3] = Math.round(outA * 255)
}

export { flattenCubic, flattenQuadratic, commandsToContours, fillContours, blendPixel }