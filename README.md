# PixCore

Lightweight, buffer-in / buffer-out image processing for Node.js — no native
dependencies, no compilation step.

Built and tested for use with [Bail-Lite](https://github.com/Lord-Samuel/Bail-lite)
— it includes a WhatsApp-sticker EXIF writer out of the box.

## Install

```bash
npm install pixcore
```

## Quick start

```js
import { read } from 'pixcore'

const img = await read(buffer)

const out = await img
    .resize(500, 500, { fit: 'cover' })
    .sharpen(0.5)
    .toBuffer({ format: 'jpeg', quality: 85 })
```

# API

## `read(buffer)`

Decodes a PNG, JPEG, or WebP buffer and returns a `PixCore` instance. Format
is auto-detected from the buffer's magic bytes — you never need to specify it.

```js
const img = await read(buffer)
```

## `.metadata()`

Returns metadata for the image as currently loaded (source format, current
dimensions, alpha usage, original file size).

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

## `.stats()` *(async)*

Basic per-channel mean values.

```js
await img.stats()
// { channels: [{ mean }, { mean }, { mean }, { mean }] }  // R, G, B, A
```

## `.resize(width, height, { fit })`

Resize the image. Omit either dimension to preserve aspect ratio.

- `fit: 'fill'` *(default)* — stretch to exact dimensions
- `fit: 'cover'` — fill the box, cropping any overflow
- `fit: 'contain'` — fit inside the box, no cropping

```js
img.resize(300, 300, { fit: 'cover' })
img.resize(300) // height auto-computed from aspect ratio
```

## `.extract({ left, top, width, height })`

Crop to a rectangle. `width`/`height` default to the remaining image extent
from `left`/`top` if omitted.

```js
img.extract({ left: 10, top: 10, width: 200, height: 200 })
```

## `.extend({ top, bottom, left, right, background })`

Pad the canvas. `background` is `[r, g, b, a]`.

```js
img.extend({ top: 20, bottom: 20, left: 20, right: 20, background: [255, 255, 255, 255] })
```

## `.trim({ threshold, background })`

Trim uniform borders. If `background` is omitted, it's auto-detected from the
top-left corner pixel (matching the common case of a solid-colored border).
`threshold` (default `10`) allows for minor JPEG compression noise around the
edge.

```js
img.trim()
img.trim({ threshold: 5, background: [255, 255, 255, 255] })
```

## `.composite(layers)` *(async)*

Alpha-blend one or more overlay images onto the current image.

```js
await img.composite([
    { input: logoBuffer, left: 10, top: 10 }
])
```

`input` can be a `Buffer` (decoded automatically) or an already-decoded
`{ data, width, height }` object.

## `.grayscale()` / `.greyscale()`

Convert to grayscale (luminance-weighted).

## `.negate()`

Invert RGB channels.

## `.normalize()` / `.normalise()`

Stretch contrast to use the full 0–255 range per channel.

## `.tint([r, g, b])`

Multiply each channel toward a target color.

```js
img.tint([255, 200, 150]) // warm tint
```

## `.blur(radius = 2)`

Separable box blur.

## `.sharpen(amount = 1)`

3×3 Laplacian-style sharpen.

## `.flip()` / `.flop()`

Vertical / horizontal mirror.

## `.rotate(degrees = 90)`

Rotate by a multiple of 90° (90, 180, 270, or negative equivalents).

## `.ensureAlpha()` / `.removeAlpha()`

`removeAlpha()` flattens the alpha channel to fully opaque. Internal pixel
format is always RGBA, so `ensureAlpha()` is a no-op kept for API parity.

## `.jpeg(opts)` / `.png(opts)` / `.webp(opts)`

Set the output format and its options ahead of `.toBuffer()`. Purely a
convenience — equivalent to passing the same options directly to
`.toBuffer()`.

```js
img.jpeg({ quality: 90 })
img.webp({ quality: 80, exif: { packname: 'My Pack', author: 'Me' } })
```

## `.toBuffer(opts)` *(async)*

Encodes the current pipeline state and returns a `Buffer`.

```js
await img.toBuffer({ format: 'jpeg', quality: 85 })
await img.toBuffer({ format: 'png' })
await img.toBuffer({ format: 'webp', quality: 80 })
```

Defaults to `jpeg` at quality `80` if no format was set via `.jpeg()`/`.png()`/`.webp()`.

### webp metadata encoding 

When encoding to WebP, passing `exif` embeds metadata (pack name, author, emoji categories) directly into the output..

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

This writes a real EXIF chunk into the WebP RIFF container (synthesizing the
required `VP8X` chunk if the encoded WebP doesn't already have one), matching
the format WhatsApp clients read pack/author info from.

## Supported formats

| | Read | Write |
|---|---|---|
| PNG | ✅ | ✅ |
| JPEG | ✅ | ✅ |
| WebP | ✅ *(optional)* | ✅ *(optional)* |


## Design notes

- Internal pixel representation is always raw RGBA (`Uint8Array`), regardless
  of source or target format.
- All pipeline operations (`resize`, `crop`, `blur`, etc.) run eagerly, not
  lazily — there's no deferred execution graph like `sharp`'s libvips
  pipeline. This keeps the implementation simple; it's intended for
  bot-sized images (avatars, stickers, thumbnails, small photos), not large
  batch image processing.
- `.metadata().size` reports the **original input buffer's byte size**, not
  a recomputed size after pipeline operations — this matches `sharp`'s own
  behavior.
- `blur`/`sharpen` use simple, correct algorithms (box blur, Laplacian
  sharpen) rather than `sharp`'s Gaussian kernels — visually close enough for
  typical bot use, not pixel-identical to `sharp`'s output.


## License

MIT
