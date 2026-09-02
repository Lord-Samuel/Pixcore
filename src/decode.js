import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { createRequire } from 'module'
import { readFile } from 'fs/promises'

const require = createRequire(import.meta.url)

let webpDecodeFn;
let webpInitialized = false;

async function getWebpDecoder() {
    if (webpDecodeFn === undefined) {
        try {
            const mod = await import('@jsquash/webp/decode.js');
            webpDecodeFn = mod.default;
            
            if (!webpInitialized && webpDecodeFn) {
                const wasmPath = require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')
                const wasmBuffer = await readFile(wasmPath)
                const wasmModule = new WebAssembly.Module(wasmBuffer)
        
                if (mod.init) {
                    await mod.init(wasmModule)
                    webpInitialized = true
                }
            }
        }
        catch {
            webpDecodeFn = null;
        }
    }
    if (!webpDecodeFn) {
        throw new Error('WebP decoding requires the optional "@jsquash/webp" package to be installed');
    }
    return webpDecodeFn;
}

function sniffFormat(buffer) {
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'png';
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        return 'jpeg';
    }
    if (buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'webp';
    }
    throw new Error('Unsupported image format (only PNG/JPEG/WebP input supported)');
}

async function decode(buffer) {
    const format = sniffFormat(buffer);
    const originalSize = buffer.length;
    if (format === 'png') {
        const png = PNG.sync.read(buffer);
        return { data: new Uint8Array(png.data), width: png.width, height: png.height, format, originalSize };
    }
    if (format === 'jpeg') {
        const raw = jpeg.decode(buffer, { useTArray: true });
        return { data: raw.data, width: raw.width, height: raw.height, format, originalSize };
    }
    const webpDecode = await getWebpDecoder();
    const imageData = await webpDecode(buffer);
    return { data: new Uint8Array(imageData.data), width: imageData.width, height: imageData.height, format, originalSize };
}

export { decode, sniffFormat };
