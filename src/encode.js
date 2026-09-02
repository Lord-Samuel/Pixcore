import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { createRequire } from 'module'
import { readFileSync } from 'fs'

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
        data: Buffer.from(data),
        width,
        height
    }
    
    const encoded = await webpEncodeFn(imageData, { quality })
    return Buffer.from(encoded)
}

export { toJpeg, toPng, toWebp }
