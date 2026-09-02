const NAMED_COLORS = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
    pink: '#ffc0cb', gray: '#808080', grey: '#808080', cyan: '#00ffff',
    magenta: '#ff00ff', lime: '#00ff00', navy: '#000080', teal: '#008080',
    brown: '#a52a2a', transparent: 'rgba(0,0,0,0)'
}

/**
 * Parse a CSS-style color string into {r,g,b,a} with r/g/b in 0-255 and a in 0-1.
 * Supports: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(...), rgba(...), a small set
 * of named colors, and "transparent".
 */
function parseColor(input) {
    if (input && typeof input === 'object' && 'r' in input) {
        return { r: input.r, g: input.g, b: input.b, a: input.a ?? 1 }
    }
    if (typeof input !== 'string') {
        throw new Error(`Invalid color: ${input}`)
    }
    let str = input.trim().toLowerCase()
    if (str in NAMED_COLORS) str = NAMED_COLORS[str]

    if (str.startsWith('#')) {
        const hex = str.slice(1)
        if (hex.length === 3 || hex.length === 4) {
            const r = parseInt(hex[0] + hex[0], 16)
            const g = parseInt(hex[1] + hex[1], 16)
            const b = parseInt(hex[2] + hex[2], 16)
            const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1
            return { r, g, b, a }
        }
        if (hex.length === 6 || hex.length === 8) {
            const r = parseInt(hex.slice(0, 2), 16)
            const g = parseInt(hex.slice(2, 4), 16)
            const b = parseInt(hex.slice(4, 6), 16)
            const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
            return { r, g, b, a }
        }
        throw new Error(`Invalid hex color: ${input}`)
    }

    const rgbMatch = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
    if (rgbMatch) {
        return {
            r: Math.round(parseFloat(rgbMatch[1])),
            g: Math.round(parseFloat(rgbMatch[2])),
            b: Math.round(parseFloat(rgbMatch[3])),
            a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1
        }
    }

    throw new Error(`Unrecognized color format: ${input}`)
}

export { parseColor }
