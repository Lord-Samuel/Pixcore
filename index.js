import { decode } from './src/decode.js'
import * as ops from './src/ops.js'
import * as encode from './src/encode.js'
import { writeExif } from './src/exif.js'
import { createCanvas } from './src/canvas.js'

class PixCore {
    constructor(img) {
        this._img = img
        this._originalFormat = img.format
        this._originalSize = img.originalSize
        this._targetFormat = null
        this._animated = !!img.animated
        this._frames = img.frames || null
        this._loop = img.loop ?? 0
    }

    static fromCanvas(canvas) {
        return new PixCore(canvas.toImage())
    }

    metadata() {
        return {
            format: this._originalFormat,
            width: this._img.width,
            height: this._img.height,
            channels: 4,
            hasAlpha: ops.detectAlphaUsage(this._img),
            size: this._originalSize,
            space: 'srgb',
            animated: this._animated,
            ...(this._animated ? { pages: this._frames.length, loop: this._loop } : {})
        }
    }

    isAnimated() {
        return this._animated
    }

    /**
     * For an animated source, returns one PixCore instance per frame (each a
     * full-canvas RGBA still), with `.duration` (ms, WebP's native unit) and
     * `.loop` attached. Operations like resize/crop can be applied to each
     * frame independently. Throws if the source isn't animated.
     */
    frames() {
        if (!this._animated) throw new Error('frames(): source is not an animated image')
        return this._frames.map(f => {
            const frame = new PixCore({ data: f.data, width: f.width, height: f.height, format: 'raw', originalSize: f.originalSize })
            frame.duration = f.duration
            frame.loop = this._loop
            return frame
        })
    }

    async stats() {
        return ops.computeStats(this._img)
    }

    /**
     * Runs `fn({data,width,height}) -> {data,width,height}` on the image.
     * For an animated source, runs it on every frame (preserving each
     * frame's duration) and keeps _img in sync with frame 0, so
     * metadata()/frames()/toBuffer() never disagree about the current
     * state. For a still image, it just replaces _img.
     */
    _apply(fn) {
        if (this._animated) {
            this._frames = this._frames.map(f => {
                const out = fn({ data: f.data, width: f.width, height: f.height })
                return { data: out.data, width: out.width, height: out.height, duration: f.duration, format: 'raw', originalSize: out.data.length }
            })
            this._img = this._frames[0]
        } else {
            this._img = fn(this._img)
        }
        return this
    }

    resize(width, height, { fit = 'fill', background } = {}) {
        return this._apply(img => {
            if (!width && !height) return img
            let w = width, h = height
            if (!h) h = Math.round(img.height * (w / img.width))
            if (!w) w = Math.round(img.width * (h / img.height))

            if (fit === 'cover') return ops.resizeCover(img, w, h)
            if (fit === 'contain') return ops.resizeContain(img, w, h, { background })
            return ops.resizeSmooth(img, w, h)
        })
    }

    extract({ left = 0, top = 0, width, height } = {}) {
        return this._apply(img => {
            const w = width === undefined ? img.width - left : width
            const h = height === undefined ? img.height - top : height
            return ops.crop(img, left, top, w, h)
        })
    }

    extend(opts) {
        return this._apply(img => ops.extend(img, opts))
    }

    trim(opts = {}) {
        if (!this._animated) {
            return this._apply(img => ops.trim(img, opts))
        }

        // Every frame must come out the same size afterward (animated WebP
        // requires it), so find ONE bounding box that covers the union of
        // non-background content across every frame, then crop every frame
        // to that same rectangle — rather than trimming each frame to its
        // own independent (and possibly differently-sized) content box.
        const background = opts.background ?? Array.from(this._frames[0].data.slice(0, 4))
        const { width, height } = this._frames[0]
        let top = height, bottom = -1, left = width, right = -1

        for (const f of this._frames) {
            const box = ops.findContentBounds(f, { ...opts, background })
            if (!box) continue // this frame is entirely background; contributes nothing
            top = Math.min(top, box.top)
            bottom = Math.max(bottom, box.bottom)
            left = Math.min(left, box.left)
            right = Math.max(right, box.right)
        }

        if (bottom < top || right < left) {
            // every frame was entirely background - nothing to trim
            return this
        }

        return this._apply(img => ops.crop(img, left, top, right - left + 1, bottom - top + 1))
    }

    async composite(layers = []) {
        const overlayImgs = await Promise.all(layers.map(layer =>
            Buffer.isBuffer(layer.input) ? decode(layer.input) : layer.input
        ))
        overlayImgs.forEach((overlay, i) => {
            const isValid = overlay &&
                overlay.data instanceof Uint8Array &&
                Number.isInteger(overlay.width) && overlay.width > 0 &&
                Number.isInteger(overlay.height) && overlay.height > 0
            if (!isValid) {
                throw new Error(
                    `composite: layers[${i}].input is invalid. Use Buffer, { data, width, height }, or canvas.toImage()`
                )
            }
            if (overlay.animated) {
                throw new Error(
                    `composite: layers[${i}].input is an animated image — only its first frame would be ` +
                    `used, which is probably not what you want. Decode it, pick a frame via .frames(), and ` +
                    `pass that frame's { data, width, height } instead.`
                )
            }
        })
        return this._apply(img => {
            let out = img
            layers.forEach((layer, i) => {
                out = ops.composite(out, overlayImgs[i], { left: layer.left || 0, top: layer.top || 0 })
            })
            return out
        })
    }

    grayscale() { return this._apply(img => ops.grayscale(img)) }
    greyscale() { return this.grayscale() }

    negate() { return this._apply(img => ops.negate(img)) }
    normalize() { return this._apply(img => ops.normalize(img)) }
    normalise() { return this.normalize() }

    tint(rgb) { return this._apply(img => ops.tint(img, rgb)) }

    blur(radius = 2) { return this._apply(img => ops.blur(img, radius)) }
    sharpen(amount = 1) { return this._apply(img => ops.sharpen(img, amount)) }

    ensureAlpha() { return this._apply(img => ops.ensureAlpha(img)) }
    removeAlpha() { return this._apply(img => ops.removeAlpha(img)) }

    flip() { return this._apply(img => ops.flip(img)) }
    flop() { return this._apply(img => ops.flop(img)) }

    rotate(degrees = 90) {
        const steps = ((Math.round(degrees / 90) % 4) + 4) % 4
        return this._apply(img => {
            let out = img
            for (let i = 0; i < steps; i++) out = ops.rotate90(out)
            return out
        })
    }

    jpeg(opts = {}) { this._targetFormat = { format: 'jpeg', ...opts }; return this }
    png(opts = {}) { this._targetFormat = { format: 'png', ...opts }; return this }
    webp(opts = {}) { this._targetFormat = { format: 'webp', ...opts }; return this }

    async toBuffer(opts = {}) {
        const resolved = { ...this._targetFormat, ...opts }
        const format = resolved.format || 'jpeg'
        
        if (format === 'webp') {
            const buffer = this._animated
                ? await encode.toAnimatedWebp(
                    this._frames.map(f => ({ data: f.data, width: f.width, height: f.height, duration: f.duration })),
                    { quality: resolved.quality ?? 80, loop: this._loop }
                  )
                : await encode.toWebp(this._img, resolved.quality ?? 80)

            if (resolved.exif) {
                return writeExif(buffer, { width: this._img.width, height: this._img.height }, resolved.exif)
            }
            return buffer
        }
        
        if (format === 'png') return encode.toPng(this._img)
        return encode.toJpeg(this._img, resolved.quality ?? 80)
    }
}

async function read(buffer) {
    const decoded = await decode(buffer)
    return new PixCore(decoded)
}

function fromCanvas(canvas) {
    return new PixCore(canvas.toImage())
}

/**
 * Encode a sequence of frames as an animated WebP buffer. Accepts either
 * PixCore instances (as returned by img.frames(), including their attached
 * .duration) or plain { data, width, height, duration } objects. All frames
 * must be the same size — resize each one first if the source frames differ.
 *
 *   const img = await pix.read(buffer)
 *   const frames = img.frames().map(f => f.resize(200, 200))
 *   const out = await pix.writeAnimated(frames, { loop: img.metadata().loop })
 */
async function writeAnimated(frames, opts = {}) {
    if (!frames.length) throw new Error('writeAnimated: no frames provided')

    frames.forEach((f, i) => {
        if (f instanceof PixCore && f.isAnimated()) {
            throw new Error(
                `writeAnimated: frames[${i}] is an animated PixCore — pass its individual frames ` +
                `(img.frames()), not the animated parent itself`
            )
        }
    })

    const resolved = frames.map(f =>
        f instanceof PixCore
            ? { data: f._img.data, width: f._img.width, height: f._img.height, duration: f.duration ?? 100 }
            : f
    )
    const loop = opts.loop ?? (frames[0] instanceof PixCore ? (frames[0].loop ?? 0) : 0)

    return encode.toAnimatedWebp(resolved, { ...opts, loop })
}

export { read, PixCore, createCanvas, fromCanvas, writeAnimated }
