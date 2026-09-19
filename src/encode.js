import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { buildAnimatedWebpContainer } from './animated.js'

const require = createRequire(import.meta.url)

let webpEncodeFn;
let webpInitialized = false;

async function initWebPEncoder() {
    if (webpInitialized) return;
    
    try {
        const mod = await import('@jsquash/webp/encode.js')
        webpEncodeFn = mod.default
        
        const wasmPath = require.resolve('@jsquash/webp/codec/enc/webp_enc.wasm')
        const wasmBuffer = readFileSync(wasmPath)
        const wasmModule = new WebAssembly.Module(wasmBuffer)
        
        if (mod.init) {
            await mod.init(wasmModule)
            webpInitialized = true
        }
    }
    catch (e) {
        console.error('Failed to init WebP encoder:', e.message)
        webpEncodeFn = null
    }
}

function toJpeg({ data, width, height }, quality = 80) {
    const encoded = jpeg.encode({ data, width, height }, quality)
    return Buffer.from(encoded.data)
}

function toPng({ data, width, height }) {
    const png = new PNG({ width, height })
    png.data = Buffer.from(data)
    return PNG.sync.write(png)
}

async function toWebp({ data, width, height }, quality = 80) {
    await initWebPEncoder()
    
    if (!webpEncodeFn) {
        throw new Error('WebP encoding requires "@jsquash/webp" to be installed')
    }
    
    const imageData = {
        data: ArrayBuffer.isView(data) ? data : Buffer.from(data),
        width,
        height
    }
    
    const encoded = await webpEncodeFn(imageData, { quality })
    return Buffer.from(encoded)
}

/**
 * Encode a sequence of full-canvas RGBA frames as an animated WebP.
 * `frames`: array of { data, width, height, duration }. All frames must
 */
async function toAnimatedWebp(frames, { quality = 80, loop = 0, background = [0, 0, 0, 0] } = {}) {
    await initWebPEncoder()

    if (!webpEncodeFn) {
        throw new Error('Animated WebP encoding requires "@jsquash/webp" to be installed')
    }
    if (!frames.length) throw new Error('toAnimatedWebp: no frames provided')

    const { width, height } = frames[0]
    const encodedFrames = []

    for (const frame of frames) {
        if (frame.width !== width || frame.height !== height) {
            throw new Error('toAnimatedWebp: all frames must share the same dimensions (resize them to match first)')
        }
        const imageData = {
            data: ArrayBuffer.isView(frame.data) ? frame.data : Buffer.from(frame.data),
            width: frame.width,
            height: frame.height
        }
        const encoded = await webpEncodeFn(imageData, { quality })
        encodedFrames.push({ webpBuffer: Buffer.from(encoded), duration: frame.duration ?? 100 })
    }

    return buildAnimatedWebpContainer(encodedFrames, { width, height, loop, background })
}

export { toJpeg, toPng, toWebp, toAnimatedWebp }
