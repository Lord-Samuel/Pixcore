import { decode } from './src/decode.js'
import * as ops from './src/ops.js'
import * as encode from './src/encode.js'
import { writeExif } from './src/exif.js'

class PixCore {
    constructor(img) {
        this._img = img
        this._originalFormat = img.format
        this._originalSize = img.originalSize
        this._targetFormat = null
    }

    metadata() {
        return {
            format: this._originalFormat,
            width: this._img.width,
            height: this._img.height,
            channels: 4,
            hasAlpha: ops.detectAlphaUsage(this._img),
            size: this._originalSize,
            space: 'srgb'
        }
    }

    async stats() {
        return ops.computeStats(this._img)
    }

    resize(width, height, { fit = 'fill' } = {}) {
        if (!width && !height) return this
        if (!height) height = Math.round(this._img.height * (width / this._img.width))
        if (!width) width = Math.round(this._img.width * (height / this._img.height))

        if (fit === 'cover') this._img = ops.resizeCover(this._img, width, height)
        else if (fit === 'contain') this._img = ops.resizeContain(this._img, width, height)
        else this._img = ops.resizeBilinear(this._img, width, height)
        return this
    }

    extract({ left = 0, top = 0, width, height }) {
        if (width === undefined) width = this._img.width - left
        if (height === undefined) height = this._img.height - top
        this._img = ops.crop(this._img, left, top, width, height)
        return this
    }

    extend(opts) {
        this._img = ops.extend(this._img, opts)
        return this
    }
    
    trim(opts = {}) {
        this._img = ops.trim(this._img, opts)
        return this
    }

    async composite(layers = []) {
        for (const layer of layers) {
            const overlayImg = Buffer.isBuffer(layer.input)
                ? await decode(layer.input)
                : layer.input
            this._img = ops.composite(this._img, overlayImg, { left: layer.left || 0, top: layer.top || 0 })
        }
        return this
    }

    grayscale() { this._img = ops.grayscale(this._img); return this }
    greyscale() { return this.grayscale() }

    negate() { this._img = ops.negate(this._img); return this }
    normalize() { this._img = ops.normalize(this._img); return this }
    normalise() { return this.normalize() }

    tint(rgb) { this._img = ops.tint(this._img, rgb); return this }

    blur(radius = 2) { this._img = ops.blur(this._img, radius); return this }
    sharpen(amount = 1) { this._img = ops.sharpen(this._img, amount); return this }

    ensureAlpha() { this._img = ops.ensureAlpha(this._img); return this }
    removeAlpha() { this._img = ops.removeAlpha(this._img); return this }

    flip() { this._img = ops.flip(this._img); return this }
    flop() { this._img = ops.flop(this._img); return this }

    rotate(degrees = 90) {
        const steps = ((Math.round(degrees / 90) % 4) + 4) % 4
        for (let i = 0; i < steps; i++) this._img = ops.rotate90(this._img)
        return this
    }

    jpeg(opts = {}) { this._targetFormat = { format: 'jpeg', ...opts }; return this }
    png(opts = {}) { this._targetFormat = { format: 'png', ...opts }; return this }
    webp(opts = {}) { this._targetFormat = { format: 'webp', ...opts }; return this }

    async toBuffer(opts = {}) {
        const resolved = { ...this._targetFormat, ...opts }
        const format = resolved.format || 'jpeg'
        
        if (format === 'webp') {
            const buffer = await encode.toWebp(this._img, resolved.quality || 80)
            if (resolved.exif) {
                const { width, height } = this.metadata()
                return writeExif(buffer, { width, height }, resolved.exif)
            }
            return buffer
        }
        
        if (format === 'png') return encode.toPng(this._img)
        return encode.toJpeg(this._img, resolved.quality || 80)
    }
}

async function read(buffer) {
    const decoded = await decode(buffer)
    return new PixCore(decoded)
}

export { read, PixCore }
