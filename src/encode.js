import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

function toJpeg({ data, width, height }, quality = 80) {
    const encoded = jpeg.encode({ data, width, height }, quality);
    return Buffer.from(encoded.data);
}

function toPng({ data, width, height }) {
    const png = new PNG({ width, height });
    png.data = Buffer.from(data);
    return PNG.sync.write(png);
}

export { toJpeg, toPng };