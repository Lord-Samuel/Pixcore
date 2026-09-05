# pixcore

[![npm version](https://img.shields.io/npm/v/pixcore.svg)](https://www.npmjs.com/package/pixcore)
[![license](https://img.shields.io/npm/l/pixcore.svg)](https://github.com/Lord-Samuel/Pixcore/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/pixcore.svg)](https://www.npmjs.com/package/pixcore)

A fast, chainable image processing and canvas library for Node.js — decode, transform, draw, and encode, with first-class support for WhatsApp-style stickers and color emoji text rendering.

No native compilation step. No prebuilt binaries to fetch per-platform. Just JavaScript and WebAssembly.

```js
import pix from 'pixcore'

const sticker = await (await pix.read(imageBuffer))
  .resize(512, 512, { fit: 'contain' })
  .sharpen(1.2)
  .webp({ quality: 90 })
  .toBuffer({
    exif: { packname: 'My Pack', author: 'Me', categories: ['😀', '🎉'] }
  })
```

## Why pixcore

- **Zero native dependencies.** Decoding/encoding runs on pure JS (`pngjs`, `jpeg-js`) and WebAssembly (`@jsquash/webp`) — no `node-gyp`, no platform-specific prebuilt binaries. Install and go, including on serverless/edge runtimes where that matters most.
- **A real canvas API.** Shapes, gradients, strokes, and text — including color emoji — with no dependency on `node-canvas`/Cairo.
- **Sticker-aware.** Purpose-built WebP EXIF metadata writing for WhatsApp sticker packs (pack ID, name, publisher, emoji tags, and more), not bolted on as an afterthought.
- **Chainable, promise-based API** in the shape you'd expect if you've used `sharp`.

pixcore is not trying to out-benchmark `sharp` at raw pixel throughput — `sharp` wraps `libvips`, native C++ with SIMD, and that's a structural advantage pure JS/WASM can't close. Where pixcore earns its place is zero-native-dependency installs, and a feature set (canvas + emoji + sticker metadata) `sharp` doesn't have at all.

## Installation

```sh
npm install pixcore
```

Requires Node.js 16+. Ships as an ES module (`import`, not `require`).

## Quick start

```js
import pix from 'pixcore'
import fs from 'fs/promises'

const buffer = await fs.readFile('./photo.jpg')

const thumbnail = await (await pix.read(buffer))
  .resize(300, 300, { fit: 'cover' })
  .grayscale()
  .png()
  .toBuffer()

await fs.writeFile('./thumbnail.png', thumbnail)
```

Reading auto-detects PNG, JPEG, or WebP from the buffer's contents — no need to specify the source format.

## API

### `pix.read(buffer)`

Decodes a PNG/JPEG/WebP buffer and returns a `PixCore` instance for chaining. Async.

### Transform methods

All of these mutate and return `this`, so calls chain naturally. None of them encode anything — call `.toBuffer()` (or a format-setter + `.toBuffer()`) when you're done transforming.

| Method | Description |
|---|---|
| `resize(width, height, { fit, background })` | `fit`: `'fill'` (default, stretches), `'cover'` (crops to fill exactly), or `'contain'` (letterboxes to exactly `width`×`height`, padded with `background`, default transparent). Omit either dimension to preserve aspect ratio. |
| `extract({ left, top, width, height })` | Crop to a region. |
| `extend({ top, bottom, left, right, background })` | Pad the canvas outward. |
| `trim({ threshold, background })` | Auto-crop uniform/transparent borders. |
| `composite(layers)` | Stack images on top. `layers`: `[{ input, left, top }]`, where `input` is a Buffer, a decoded image object, or a canvas (`.toImage()`). |
| `rotate(degrees)` | Rotates by any multiple of 90°. |
| `flip()` / `flop()` | Vertical / horizontal mirror. |
| `grayscale()` / `greyscale()` | Desaturate. |
| `negate()` | Invert colors. |
| `normalize()` / `normalise()` | Stretch contrast to the full 0–255 range. |
| `tint([r, g, b])` | Multiply toward a color. |
| `blur(radius)` | Box blur. |
| `sharpen(amount)` | Unsharp-style convolution sharpen. |
| `ensureAlpha()` / `removeAlpha()` | Add/flatten the alpha channel. |

### Reading info

- `metadata()` — `{ format, width, height, channels, hasAlpha, size, space }`
- `stats()` — per-channel min/max/mean (async)

### Encoding

```js
img.png()                     // set target format
img.jpeg({ quality: 85 })
img.webp({ quality: 90 })

await img.toBuffer()          // encode using whatever format was set (defaults to jpeg)
await img.toBuffer({ format: 'webp', quality: 80 })   // or specify inline
```

### Sticker metadata (WebP only)

Pass an `exif` object when encoding to WebP to embed WhatsApp sticker pack metadata directly into the file:

```js
await img.webp({ quality: 90 }).toBuffer({
  exif: {
    packId: 'my-pack-2024',      // use the SAME id across every sticker in one pack
    packname: 'My Sticker Pack',
    author: 'Me',
    categories: ['😀', '🎉'],     // emoji tags for this sticker
    isAvatarSticker: false,
    publisherEmail: 'me@example.com',
    publisherWebsite: 'https://example.com',
    androidAppStoreLink: 'https://play.google.com/store/apps/details?id=...',
    iosAppStoreLink: 'https://apps.apple.com/app/id...',
    privacyPolicyWebsite: 'https://example.com/privacy',
    licenseAgreementWebsite: 'https://example.com/license'
  }
})
```

Only `packname`, `author`, and `categories` are commonly needed — everything else is optional. Handles both WebP container variants correctly (synthesizes the required `VP8X` chunk for simple-format sources, reuses it when already present).

## Canvas

Draw shapes and text from scratch, or use a canvas as a layer to composite onto a decoded image.

```js
import pix from 'pixcore'

const canvas = pix.createCanvas(400, 400, { background: '#fff9e6' })

canvas
  .rect({ x: 20, y: 20, width: 360, height: 360, radius: 24, fill: '#ffffff', stroke: '#2b2b2b', strokeWidth: 6 })
  .circle({ x: 150, y: 130, radius: 60, fill: { type: 'radial', from: { x: 150, y: 130 }, to: 60,
      stops: [{ color: '#ffe066', offset: 0 }, { color: '#ff8c42', offset: 1 }] } })
  .star({ x: 300, y: 130, points: 5, outerRadius: 45, innerRadius: 20, fill: '#06d6a0' })

await canvas.text('Happy Birthday!', {
  x: 200, y: 320, size: 40, color: '#2b2b2b', align: 'center',
  font: './fonts/Bold.ttf'
})

const img = pix.PixCore.fromCanvas(canvas)
const buffer = await img.png().toBuffer()
```

### Shapes

All shape methods return `this` for chaining, and accept `fill`/`stroke`/`strokeWidth`. `fill` accepts a CSS-style color string (`'#ff0000'`, `'rgba(255,0,0,0.5)'`, `'hsl(200,80%,50%)'`, named colors) **or** a gradient descriptor (see below).

| Method | Options |
|---|---|
| `rect({ x, y, width, height, radius })` | `radius` for rounded corners |
| `circle({ x, y, radius })` | |
| `ellipse({ x, y, rx, ry })` | |
| `line({ x1, y1, x2, y2, color, width })` | |
| `arc({ x, y, radius, startAngle, endAngle })` | Filled as a pie wedge (radians) |
| `polygon({ points })` | `points`: `[{x,y}, ...]` |
| `triangle({ x1, y1, x2, y2, x3, y3 })` | |
| `star({ x, y, points, outerRadius, innerRadius })` | |
| `path({ commands })` | Raw path commands: `{type:'M'|'L'|'C'|'Q'|'Z', ...}` |

### Gradients

Use a gradient as any shape's `fill`, clipped exactly to that shape:

```js
fill: {
  type: 'linear',                 // or 'radial'
  from: { x: 0, y: 0 },
  to: { x: 200, y: 0 },            // a point for linear, or a radius (number) for radial
  stops: [{ color: '#ff0055', offset: 0 }, { color: '#5500ff', offset: 1 }]
}
```

`canvas.gradient({ type, from, to, stops })` paints a gradient across the *entire* canvas instead, overwriting whatever was drawn before it — call it first, as a background.

### Text

```js
await canvas.text('Hello world!', {
  x: 20, y: 60, size: 32, color: '#1e1e2e',
  font: './fonts/Regular.ttf',   // required — any .ttf/.otf
  align: 'left',                  // 'left' | 'center' | 'right'
  strokeColor: '#000000',
  strokeWidth: 2
})
```

`canvas.textBg(str, opts)` draws the same text with an automatic background pill behind it (`bg`, `bgPadding`, `borderRadius` options).

#### Emoji

Regular text fonts don't contain emoji glyphs, and real color-emoji fonts use formats a plain vector-outline renderer can't read at all — so pixcore handles color emoji through two dedicated paths:

- **Bundled by default** — a subsetted color emoji font ships with the package, so emoji work with zero configuration:
  ```js
  await canvas.text('Nice work 🎉', { x: 20, y: 60, size: 32, font: './fonts/Regular.ttf' })
  ```
- **`colorFont`** — for COLR/CPAL-format color fonts (e.g. the current Noto Color Emoji build from Google Fonts), rendered as real layered vector paths via `opentype.js`'s native color-glyph support:
  ```js
  await canvas.text('Nice work 🎉', {
    x: 20, y: 60, size: 32, font: './fonts/Regular.ttf',
    colorFont: './fonts/NotoColorEmoji-Regular.ttf'
  })
  ```
- **`emojiFont`** — override the bundled CBDT/CBLC bitmap font with your own (defaults to the bundled one; set to `null` to disable emoji rendering entirely).

`colorFont` is tried first per character, falling back to `emojiFont`, then to leaving the character unrendered with a `console.warn` explaining why.

**Known limitation:** flag emoji, skin-tone modifiers, and ZWJ sequences (e.g. family/profession emoji) require combining multiple codepoints into one glyph via font ligature rules, which isn't implemented — each codepoint in a sequence resolves independently. Standalone emoji (the vast majority) are unaffected.

### Using a canvas as a layer

```js
const canvas = pix.createCanvas(200, 80, { background: 'transparent' })
await canvas.text('WATERMARK', { x: 10, y: 50, size: 28, color: 'rgba(255,255,255,0.6)', font: './fonts/Bold.ttf' })

const img = await pix.read(photoBuffer)
await img.composite([{ input: canvas.toImage(), left: 20, top: 20 }])
```

## Supported formats

| | Decode | Encode |
|---|---|---|
| PNG | ✓ | ✓ |
| JPEG | ✓ | ✓ |
| WebP | ✓ | ✓ (+ sticker EXIF) |

## License

MIT
