# PixCore

Lightweight, buffer-in / buffer-out image processing and canvas creation for Node.js — no native dependencies, no compilation step.

Built and tested for use with [Bail-Lite](https://github.com/Lord-Samuel/Bail-lite) — it includes a WhatsApp-sticker EXIF writer out of the box.

---

## Install

```bash
npm install pixcore
```

---

## Quick Start

```js
import { read, createCanvas } from 'pixcore'

// Process an existing image
const img = await read(buffer)
const out = await img
    .resize(500, 500, { fit: 'cover' })
    .sharpen(0.5)
    .toBuffer({ format: 'jpeg', quality: 85 })

// Create an image from scratch
const canvas = createCanvas(500, 500, { background: '#fff9e6' })
canvas
    .rect({ x: 10, y: 10, width: 480, height: 480, radius: 24, fill: '#fff9e6', stroke: '#2b2b2b', strokeWidth: 6 })
    .circle({ x: 250, y: 200, radius: 80, fill: '#ffd166' })
await canvas.text('Hello!', { x: 250, y: 350, size: 48, color: '#2b2b2b', align: 'center', font: './Menlo-Bold.ttf' })

const canvasImg = PixCore.fromCanvas(canvas)
const buffer = await canvasImg.toBuffer({ format: 'png' })
```

---

## Core API

### `read(buffer)`

Decodes a PNG, JPEG, or WebP buffer and returns a PixCore instance. Format is auto-detected from the buffer's magic bytes — you never need to specify it.

```js
const img = await read(buffer)
```

### `metadata()`

Returns metadata for the image as currently loaded (source format, current dimensions, alpha usage, original file size).

```js
img.metadata()
// {
//   format: 'jpeg',
//   width: 1920,
//   height: 1080,
//   channels: 4,
//   hasAlpha: false,
//   size: 482103,   // byte size of the ORIGINAL input buffer
//   space: 'srgb'
// }
```

### `stats()` (async)

Basic per-channel mean values.

```js
await img.stats()
// { channels: [{ mean }, { mean }, { mean }, { mean }] }  // R, G, B, A
```

---

## Transformations

### `resize(width, height, { fit })`

Resize the image. Omit either dimension to preserve aspect ratio.

- `fit: 'fill'` (default) — stretch to exact dimensions
- `fit: 'cover'` — fill the box, cropping any overflow
- `fit: 'contain'` — fit inside the box, no cropping

```js
img.resize(300, 300, { fit: 'cover' })
img.resize(300) // height auto-computed from aspect ratio
```

### `extract({ left, top, width, height })`

Crop to a rectangle. `width`/`height` default to the remaining image extent from `left`/`top` if omitted.

```js
img.extract({ left: 10, top: 10, width: 200, height: 200 })
```

### `extend({ top, bottom, left, right, background })`

Pad the canvas. `background` is `[r, g, b, a]`.

```js
img.extend({ top: 20, bottom: 20, left: 20, right: 20, background: [255, 255, 255, 255] })
```

### `trim({ threshold, background })`

Trim uniform borders. If `background` is omitted, it's auto-detected from the top-left corner pixel (matching the common case of a solid-colored border). `threshold` (default 10) allows for minor JPEG compression noise around the edge.

```js
img.trim()
img.trim({ threshold: 5, background: [255, 255, 255, 255] })
```

### `composite(layers)` (async)

Alpha-blend one or more overlay images onto the current image.

```js
await img.composite([
    { input: logoBuffer, left: 10, top: 10 }
])
```

`input` can be a Buffer (decoded automatically) or an already-decoded `{ data, width, height }` object.

---

## Color Operations

### `grayscale()` / `greyscale()`

Convert to grayscale (luminance-weighted).

### `negate()`

Invert RGB channels.

### `normalize()` / `normalise()`

Stretch contrast to use the full 0–255 range per channel.

### `tint([r, g, b])`

Multiply each channel toward a target color.

```js
img.tint([255, 200, 150]) // warm tint
```

---

## Filters

### `blur(radius = 2)`

Separable box blur.

### `sharpen(amount = 1)`

3×3 Laplacian-style sharpen.

---

## Geometric Operations

### `flip()` / `flop()`

Vertical / horizontal mirror.

### `rotate(degrees = 90)`

Rotate by a multiple of 90° (90, 180, 270, or negative equivalents).

---

## Alpha Operations

### `ensureAlpha()` / `removeAlpha()`

`removeAlpha()` flattens the alpha channel to fully opaque. Internal pixel format is always RGBA, so `ensureAlpha()` is a no-op kept for API parity.

---

## Canvas API

### `createCanvas(width, height, { background })`

Creates a blank canvas. `background` can be a hex string, RGB/RGBA string, or named color.

```js
const canvas = createCanvas(500, 500, { background: '#fff9e6' })
```

### `canvas.rect({ x, y, width, height, radius, fill, stroke, strokeWidth })`

Draws a rectangle (or rounded rectangle with `radius`).

```js
canvas.rect({ x: 10, y: 10, width: 200, height: 100, radius: 12, fill: 'red', stroke: 'black', strokeWidth: 4 })
```

### `canvas.circle({ x, y, radius, fill, stroke, strokeWidth })`

Draws a circle. `x, y` is the center.

```js
canvas.circle({ x: 250, y: 250, radius: 100, fill: 'blue' })
```

### `canvas.ellipse({ x, y, rx, ry, fill, stroke, strokeWidth })`

Draws an ellipse. `x, y` is the center.

```js
canvas.ellipse({ x: 250, y: 250, rx: 150, ry: 100, fill: 'purple' })
```

### `canvas.line({ x1, y1, x2, y2, color, width })`

Draws a line with optional thickness.

```js
canvas.line({ x1: 50, y1: 50, x2: 200, y2: 50, color: 'red', width: 3 })
```

### `canvas.path({ commands, fill, stroke, strokeWidth })`

Draws a custom path using SVG-like commands.

```js
canvas.path({ commands: [{ type: 'M', x: 10, y: 10 }, { type: 'L', x: 200, y: 10 }, { type: 'Z' }], fill: 'green' })
```

### `canvas.arc({ x, y, radius, startAngle, endAngle, fill, stroke, strokeWidth })`

Draws an arc. Angles in radians.

```js
canvas.arc({ x: 250, y: 250, radius: 100, startAngle: 0, endAngle: Math.PI / 2, fill: 'orange' })
```

### `canvas.polygon({ points, fill, stroke, strokeWidth })`

Draws a polygon from an array of `{ x, y }` points.

```js
canvas.polygon({ points: [{ x: 100, y: 50 }, { x: 200, y: 200 }, { x: 50, y: 200 }], fill: 'purple' })
```

### `canvas.triangle({ x1, y1, x2, y2, x3, y3, fill, stroke, strokeWidth })`

Draws a triangle.

```js
canvas.triangle({ x1: 100, y1: 50, x2: 200, y2: 200, x3: 50, y3: 200, fill: 'red' })
```

### `canvas.star({ x, y, points, outerRadius, innerRadius, fill, stroke, strokeWidth })`

Draws a star.

```js
canvas.star({ x: 150, y: 150, points: 5, outerRadius: 80, innerRadius: 40, fill: 'gold' })
```

### `canvas.gradient({ type, from, to, stops })`

Draws a linear or radial gradient.

```js
// Linear gradient
canvas.gradient({
    type: 'linear',
    from: { x: 0, y: 0 },
    to: { x: 500, y: 500 },
    stops: [{ color: '#ff0000', offset: 0 }, { color: '#0000ff', offset: 1 }]
})

// Radial gradient
canvas.gradient({
    type: 'radial',
    from: { x: 250, y: 250 },
    to: 250,
    stops: [{ color: '#fff9e6', offset: 0 }, { color: '#ffd166', offset: 1 }]
})
```

### `canvas.text(str, { x, y, size, color, font, align, strokeColor, strokeWidth })`

Draws text. Requires `opentype.js` and a font file.

```js
await canvas.text('Hello!', {
    x: 250,
    y: 350,
    size: 48,
    color: '#2b2b2b',
    align: 'center',
    font: './Menlo-Bold.ttf',
    strokeColor: 'white',
    strokeWidth: 4
})
```

### `canvas.textBg(str, { x, y, size, color, font, align, bg, bgPadding, borderRadius })`

Draws text with a background box.

```js
await canvas.textBg('Hello!', {
    x: 250,
    y: 350,
    size: 48,
    color: 'white',
    font: './Menlo-Bold.ttf',
    bg: 'rgba(0,0,0,0.7)',
    bgPadding: 10,
    borderRadius: 8
})
```

### `PixCore.fromCanvas(canvas)`

Converts a canvas to a PixCore instance.

```js
const img = PixCore.fromCanvas(canvas)
const buffer = await img.toBuffer({ format: 'png' })
```

---

## Output Formats

### `.jpeg(opts)` / `.png(opts)` / `.webp(opts)`

Set the output format and its options ahead of `.toBuffer()`. Purely a convenience — equivalent to passing the same options directly to `.toBuffer()`.

```js
img.jpeg({ quality: 90 })
img.webp({ quality: 80, exif: { packname: 'My Pack', author: 'Me' } })
```

### `.toBuffer(opts)` (async)

Encodes the current pipeline state and returns a Buffer.

```js
await img.toBuffer({ format: 'jpeg', quality: 85 })
await img.toBuffer({ format: 'png' })
await img.toBuffer({ format: 'webp', quality: 80 })
```

Defaults to jpeg at quality 80 if no format was set via `.jpeg()`/`.png()`/`.webp()`.

---

## WebP Metadata Encoding

When encoding to WebP, passing `exif` embeds metadata (pack name, author, emoji categories) directly into the output.

```js
const sticker = await img.toBuffer({
    format: 'webp',
    exif: {
        packname: 'My Sticker Pack',
        author: 'The Author',
        categories: ['😂']
    }
})
```

This writes a real EXIF chunk into the WebP RIFF container (synthesizing the required VP8X chunk if the encoded WebP doesn't already have one), matching the format WhatsApp clients read pack/author info from.

---

## Supported Formats

| Format | Read | Write |
|--------|:----:|:-----:|
| PNG    | ✅   | ✅    |
| JPEG   | ✅   | ✅    |
| WebP   | ✅ (optional) | ✅ (optional) |

---

## Design Notes

- Internal pixel representation is always raw RGBA (`Uint8Array`), regardless of source or target format.
- All pipeline operations (resize, crop, blur, etc.) run eagerly, not lazily — there's no deferred execution graph like sharp's libvips pipeline.
- **Quality-preserving downscaling**: for significant downscales, PixCore uses box-averaging (mipmap-style) before the final bilinear pass to avoid aliasing and preserve detail.
- **Exact stroke geometry**: canvas shapes (rect, circle, ellipse) use exact geometric offsets for strokes, so corners stay consistent even with thick strokes.
- `.metadata().size` reports the original input buffer's byte size, not a recomputed size after pipeline operations — this matches sharp's own behavior.
- `blur`/`sharpen` use simple, correct algorithms (box blur, Laplacian sharpen) rather than sharp's Gaussian kernels — visually close enough for typical bot use, not pixel-identical to sharp's output.

---

## License

MIT
