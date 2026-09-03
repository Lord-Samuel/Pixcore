function crop({ data, width, height }, x, y, w, h) {
    x = Math.max(0, Math.min(x, width));
    y = Math.max(0, Math.min(y, height));
    w = Math.max(1, Math.min(w, width - x));
    h = Math.max(1, Math.min(h, height - y));

    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
        const srcOffset = ((y + row) * width + x) * 4;
        const dstOffset = row * w * 4;
        out.set(data.subarray(srcOffset, srcOffset + w * 4), dstOffset);
    }
    return { data: out, width: w, height: h };
}

function downsampleBy2({ data, width, height }, { halveW = true, halveH = true } = {}) {
    const newW = halveW ? Math.max(1, Math.floor(width / 2)) : width;
    const newH = halveH ? Math.max(1, Math.floor(height / 2)) : height;
    const stepX = halveW ? 2 : 1;
    const stepY = halveH ? 2 : 1;
    const out = new Uint8Array(newW * newH * 4);
    for (let y = 0; y < newH; y++) {
        const srcY = y * stepY;
        const outRowBase = y * newW * 4;
        for (let x = 0; x < newW; x++) {
            const srcX = x * stepX;
            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let dy = 0; dy < stepY; dy++) {
                const sy = srcY + dy;
                if (sy >= height) continue;
                const rowBase = sy * width;
                for (let dx = 0; dx < stepX; dx++) {
                    const sx = srcX + dx;
                    if (sx >= width) continue;
                    const idx = (rowBase + sx) * 4;
                    r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                    count++;
                }
            }
            const outIdx = outRowBase + x * 4;
            out[outIdx] = Math.round(r / count);
            out[outIdx + 1] = Math.round(g / count);
            out[outIdx + 2] = Math.round(b / count);
            out[outIdx + 3] = Math.round(a / count);
        }
    }
    return { data: out, width: newW, height: newH };
}

/** Quality-preserving resize: repeated box-averaging before final bilinear pass. */
function resizeSmooth(img, targetW, targetH) {
    targetW = Math.max(1, Math.round(targetW));
    targetH = Math.max(1, Math.round(targetH));
    let current = img;
    while (current.width >= targetW * 2 || current.height >= targetH * 2) {
        const halveW = current.width >= targetW * 2;
        const halveH = current.height >= targetH * 2;
        current = downsampleBy2(current, { halveW, halveH });
    }
    return resizeBilinear(current, targetW, targetH);
}

function resizeBilinear({ data, width, height }, targetW, targetH) {
    targetW = Math.max(1, Math.round(targetW));
    targetH = Math.max(1, Math.round(targetH));
    const out = new Uint8Array(targetW * targetH * 4);
    const xRatio = width / targetW;
    const yRatio = height / targetH;

    for (let ty = 0; ty < targetH; ty++) {
        const srcY = ty * yRatio;
        const y0 = Math.floor(srcY);
        const y1 = Math.min(y0 + 1, height - 1);
        const yFrac = srcY - y0;
        const yFracInv = 1 - yFrac;
        const row0 = y0 * width;
        const row1 = y1 * width;
        const outRowBase = ty * targetW * 4;

        for (let tx = 0; tx < targetW; tx++) {
            const srcX = tx * xRatio;
            const x0 = Math.floor(srcX);
            const x1 = Math.min(x0 + 1, width - 1);
            const xFrac = srcX - x0;
            const xFracInv = 1 - xFrac;

            const i00 = (row0 + x0) * 4;
            const i10 = (row0 + x1) * 4;
            const i01 = (row1 + x0) * 4;
            const i11 = (row1 + x1) * 4;
            const outIdx = outRowBase + tx * 4;

            out[outIdx] = Math.round(
                (data[i00] * xFracInv + data[i10] * xFrac) * yFracInv +
                (data[i01] * xFracInv + data[i11] * xFrac) * yFrac);
            out[outIdx + 1] = Math.round(
                (data[i00 + 1] * xFracInv + data[i10 + 1] * xFrac) * yFracInv +
                (data[i01 + 1] * xFracInv + data[i11 + 1] * xFrac) * yFrac);
            out[outIdx + 2] = Math.round(
                (data[i00 + 2] * xFracInv + data[i10 + 2] * xFrac) * yFracInv +
                (data[i01 + 2] * xFracInv + data[i11 + 2] * xFrac) * yFrac);
            out[outIdx + 3] = Math.round(
                (data[i00 + 3] * xFracInv + data[i10 + 3] * xFrac) * yFracInv +
                (data[i01 + 3] * xFracInv + data[i11 + 3] * xFrac) * yFrac);
        }
    }
    return { data: out, width: targetW, height: targetH };
}

/** cover: fill box, crop overflow */
function resizeCover(img, targetW, targetH) {
    targetW = Math.max(1, Math.round(targetW));
    targetH = Math.max(1, Math.round(targetH));
    const scale = Math.max(targetW / img.width, targetH / img.height);
    const scaledW = Math.max(targetW, Math.ceil(img.width * scale));
    const scaledH = Math.max(targetH, Math.ceil(img.height * scale));
    const scaled = resizeSmooth(img, scaledW, scaledH);
    const cropX = Math.floor((scaledW - targetW) / 2);
    const cropY = Math.floor((scaledH - targetH) / 2);
    return crop(scaled, cropX, cropY, targetW, targetH);
}

/** contain: fit inside box preserving aspect ratio, then pad to exact target size */
function resizeContain({ data, width, height }, targetW, targetH, { background = [0, 0, 0, 0] } = {}) {
    targetW = Math.max(1, Math.round(targetW));
    targetH = Math.max(1, Math.round(targetH));
    const scale = Math.min(targetW / width, targetH / height);
    const scaledW = Math.max(1, Math.round(width * scale));
    const scaledH = Math.max(1, Math.round(height * scale));
    const scaled = resizeSmooth({ data, width, height }, scaledW, scaledH);

    const padLeft = Math.floor((targetW - scaledW) / 2);
    const padTop = Math.floor((targetH - scaledH) / 2);
    const padRight = targetW - scaledW - padLeft;
    const padBottom = targetH - scaledH - padTop;

    if (padLeft === 0 && padRight === 0 && padTop === 0 && padBottom === 0) return scaled;
    return extend(scaled, { top: padTop, bottom: padBottom, left: padLeft, right: padRight, background });
}

function grayscale({ data, width, height }) {
    for (let i = 0; i < data.length; i += 4) {
        const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        data[i] = data[i + 1] = data[i + 2] = lum;
    }
    return { data, width, height };
}

function flip({ data, width, height }) {
    const out = new Uint8Array(data.length);
    for (let row = 0; row < height; row++) {
        const srcOffset = row * width * 4;
        const dstOffset = (height - 1 - row) * width * 4;
        out.set(data.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }
    return { data: out, width, height };
}

function flop({ data, width, height }) {
    const out = new Uint8Array(data.length);
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const srcIdx = (row * width + col) * 4;
            const dstIdx = (row * width + (width - 1 - col)) * 4;
            out[dstIdx] = data[srcIdx];
            out[dstIdx + 1] = data[srcIdx + 1];
            out[dstIdx + 2] = data[srcIdx + 2];
            out[dstIdx + 3] = data[srcIdx + 3];
        }
    }
    return { data: out, width, height };
}

/** 90deg clockwise rotation */
function rotate90({ data, width, height }) {
    const out = new Uint8Array(data.length);
    const newW = height, newH = width;

    if (data.length < 12_000_000) {
        for (let row = 0; row < height; row++) {
            const srcRowBase = row * width;
            const dstCol = height - 1 - row;
            for (let col = 0; col < width; col++) {
                const srcIdx = (srcRowBase + col) * 4;
                const dstIdx = (col * newW + dstCol) * 4;
                out[dstIdx] = data[srcIdx];
                out[dstIdx + 1] = data[srcIdx + 1];
                out[dstIdx + 2] = data[srcIdx + 2];
                out[dstIdx + 3] = data[srcIdx + 3];
            }
        }
        return { data: out, width: newW, height: newH };
    }

    const TILE = 32;
    for (let rowTile = 0; rowTile < height; rowTile += TILE) {
        const rowEnd = Math.min(rowTile + TILE, height);
        for (let colTile = 0; colTile < width; colTile += TILE) {
            const colEnd = Math.min(colTile + TILE, width);
            for (let row = rowTile; row < rowEnd; row++) {
                const srcRowBase = row * width;
                const dstCol = height - 1 - row;
                for (let col = colTile; col < colEnd; col++) {
                    const srcIdx = (srcRowBase + col) * 4;
                    const dstIdx = (col * newW + dstCol) * 4;
                    out[dstIdx] = data[srcIdx];
                    out[dstIdx + 1] = data[srcIdx + 1];
                    out[dstIdx + 2] = data[srcIdx + 2];
                    out[dstIdx + 3] = data[srcIdx + 3];
                }
            }
        }
    }
    return { data: out, width: newW, height: newH };
}

function negate({ data, width, height }) {
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
    }
    return { data, width, height };
}

function normalize({ data, width, height }) {
    let min = 255, max = 0;
    for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const v = data[i + c];
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    const range = max - min || 1;
    for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.round(((data[i] - min) / range) * 255);
        data[i + 1] = Math.round(((data[i + 1] - min) / range) * 255);
        data[i + 2] = Math.round(((data[i + 2] - min) / range) * 255);
    }
    return { data, width, height };
}

function tint({ data, width, height }, [r, g, b]) {
    for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.round((data[i] * r) / 255);
        data[i + 1] = Math.round((data[i + 1] * g) / 255);
        data[i + 2] = Math.round((data[i + 2] * b) / 255);
    }
    return { data, width, height };
}

/** box blur - separable */
function blur({ data, width, height }, radius = 2) {
    radius = Math.max(1, Math.round(radius));
    const horiz = boxBlurPass({ data, width, height }, radius, true);
    return boxBlurPass(horiz, radius, false);
}

function boxBlurPass({ data, width, height }, radius, isHorizontal) {
    const out = new Uint8Array(data.length);
    const lineLen = isHorizontal ? width : height;
    const lineCount = isHorizontal ? height : width;
    const stride = (isHorizontal ? 1 : width) * 4;

    for (let line = 0; line < lineCount; line++) {
        const base = (isHorizontal ? line * width : line) * 4;
        let r = 0, g = 0, b = 0, a = 0, count = 0;

        for (let k = 0; k <= radius && k < lineLen; k++) {
            const idx = base + k * stride;
            r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
            count++;
        }
        out[base] = Math.round(r / count);
        out[base + 1] = Math.round(g / count);
        out[base + 2] = Math.round(b / count);
        out[base + 3] = Math.round(a / count);

        for (let pos = 1; pos < lineLen; pos++) {
            const addPos = pos + radius;
            const remPos = pos - radius - 1;
            if (addPos < lineLen) {
                const idx = base + addPos * stride;
                r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                count++;
            }
            if (remPos >= 0) {
                const idx = base + remPos * stride;
                r -= data[idx]; g -= data[idx + 1]; b -= data[idx + 2]; a -= data[idx + 3];
                count--;
            }
            const outIdx = base + pos * stride;
            out[outIdx] = Math.round(r / count);
            out[outIdx + 1] = Math.round(g / count);
            out[outIdx + 2] = Math.round(b / count);
            out[outIdx + 3] = Math.round(a / count);
        }
    }
    return { data: out, width, height };
}

/** unsharp-mask sharpen via 3x3 convolution */
function sharpen({ data, width, height }, amount = 1) {
    const kernel = [
        0, -1 * amount, 0,
        -1 * amount, 4 * amount + 1, -1 * amount,
        0, -1 * amount, 0
    ];
    return convolve3x3({ data, width, height }, kernel);
}

function convolve3x3({ data, width, height }, kernel) {
    const out = new Uint8Array(data.length);
    const [k00, k01, k02, k10, k11, k12, k20, k21, k22] = kernel;

    for (let y = 1; y < height - 1; y++) {
        const rowUp = (y - 1) * width;
        const rowMid = y * width;
        const rowDown = (y + 1) * width;
        for (let x = 1; x < width - 1; x++) {
            const iUL = (rowUp + x - 1) * 4, iUM = (rowUp + x) * 4, iUR = (rowUp + x + 1) * 4;
            const iML = (rowMid + x - 1) * 4, iMR = (rowMid + x + 1) * 4;
            const iDL = (rowDown + x - 1) * 4, iDM = (rowDown + x) * 4, iDR = (rowDown + x + 1) * 4;
            const outIdx = (rowMid + x) * 4;

            out[outIdx] = clamp8(
                data[iUL] * k00 + data[iUM] * k01 + data[iUR] * k02 +
                data[iML] * k10 + data[outIdx] * k11 + data[iMR] * k12 +
                data[iDL] * k20 + data[iDM] * k21 + data[iDR] * k22);
            out[outIdx + 1] = clamp8(
                data[iUL + 1] * k00 + data[iUM + 1] * k01 + data[iUR + 1] * k02 +
                data[iML + 1] * k10 + data[outIdx + 1] * k11 + data[iMR + 1] * k12 +
                data[iDL + 1] * k20 + data[iDM + 1] * k21 + data[iDR + 1] * k22);
            out[outIdx + 2] = clamp8(
                data[iUL + 2] * k00 + data[iUM + 2] * k01 + data[iUR + 2] * k02 +
                data[iML + 2] * k10 + data[outIdx + 2] * k11 + data[iMR + 2] * k12 +
                data[iDL + 2] * k20 + data[iDM + 2] * k21 + data[iDR + 2] * k22);
            out[outIdx + 3] = data[outIdx + 3];
        }
    }

    const convolveClamped = (x, y) => {
        let r = 0, g = 0, b = 0, k = 0;
        for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
                const sx = Math.min(width - 1, Math.max(0, x + kx));
                const sy = Math.min(height - 1, Math.max(0, y + ky));
                const idx = (sy * width + sx) * 4;
                const weight = kernel[k++];
                r += data[idx] * weight;
                g += data[idx + 1] * weight;
                b += data[idx + 2] * weight;
            }
        }
        const outIdx = (y * width + x) * 4;
        out[outIdx] = clamp8(r);
        out[outIdx + 1] = clamp8(g);
        out[outIdx + 2] = clamp8(b);
        out[outIdx + 3] = data[outIdx + 3];
    };

    if (height >= 1) {
        for (let x = 0; x < width; x++) {
            convolveClamped(x, 0);
            if (height > 1) convolveClamped(x, height - 1);
        }
    }
    for (let y = 1; y < height - 1; y++) {
        convolveClamped(0, y);
        if (width > 1) convolveClamped(width - 1, y);
    }

    return { data: out, width, height };
}

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

/** pad canvas with fill color */
function extend({ data, width, height }, { top = 0, bottom = 0, left = 0, right = 0, background = [0, 0, 0, 0] }) {
    const newW = width + left + right;
    const newH = height + top + bottom;
    const out = new Uint8Array(newW * newH * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = background[0] || 0;
        out[i + 1] = background[1] || 0;
        out[i + 2] = background[2] || 0;
        out[i + 3] = background[3] ?? 255;
    }
    for (let row = 0; row < height; row++) {
        const srcOffset = row * width * 4;
        const dstOffset = ((row + top) * newW + left) * 4;
        out.set(data.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }
    return { data: out, width: newW, height: newH };
}

/** trim background borders */
function trim({ data, width, height }, { threshold = 10, background } = {}) {
    if (!background) {
        background = [data[0], data[1], data[2], data[3]];
    }
    let top = 0, bottom = height - 1, left = 0, right = width - 1;
    const matchesBg = (i) => {
        return Math.abs(data[i] - background[0]) <= threshold &&
               Math.abs(data[i + 1] - background[1]) <= threshold &&
               Math.abs(data[i + 2] - background[2]) <= threshold &&
               Math.abs(data[i + 3] - background[3]) <= threshold;
    };
    
    let found = false;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!matchesBg((y * width + x) * 4)) {
                top = y;
                found = true;
                break;
            }
        }
        if (found) break;
    }
    if (!found) return { data: new Uint8Array(0), width: 0, height: 0 };
    
    found = false;
    for (let y = height - 1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
            if (!matchesBg((y * width + x) * 4)) {
                bottom = y;
                found = true;
                break;
            }
        }
        if (found) break;
    }
    
    found = false;
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            if (!matchesBg((y * width + x) * 4)) {
                left = x;
                found = true;
                break;
            }
        }
        if (found) break;
    }
    
    found = false;
    for (let x = width - 1; x >= 0; x--) {
        for (let y = 0; y < height; y++) {
            if (!matchesBg((y * width + x) * 4)) {
                right = x;
                found = true;
                break;
            }
        }
        if (found) break;
    }
    
    return crop({ data, width, height }, left, top, right - left + 1, bottom - top + 1);
}

/** overlay with proper alpha blending. Mutates base.data in place. */
function composite(base, overlayImg, { left = 0, top = 0 } = {}) {
    const out = base.data;
    for (let row = 0; row < overlayImg.height; row++) {
        const dstRow = row + top;
        if (dstRow < 0 || dstRow >= base.height) continue;
        for (let col = 0; col < overlayImg.width; col++) {
            const dstCol = col + left;
            if (dstCol < 0 || dstCol >= base.width) continue;
            const srcIdx = (row * overlayImg.width + col) * 4;
            const dstIdx = (dstRow * base.width + dstCol) * 4;
            const srcA = overlayImg.data[srcIdx + 3] / 255;
            if (srcA === 0) continue;
            const dstA = out[dstIdx + 3] / 255;
            const outA = srcA + dstA * (1 - srcA);
            if (outA === 0) {
                out[dstIdx] = out[dstIdx + 1] = out[dstIdx + 2] = 0;
            } else {
                out[dstIdx] = Math.round((overlayImg.data[srcIdx] * srcA + out[dstIdx] * dstA * (1 - srcA)) / outA);
                out[dstIdx + 1] = Math.round((overlayImg.data[srcIdx + 1] * srcA + out[dstIdx + 1] * dstA * (1 - srcA)) / outA);
                out[dstIdx + 2] = Math.round((overlayImg.data[srcIdx + 2] * srcA + out[dstIdx + 2] * dstA * (1 - srcA)) / outA);
            }
            out[dstIdx + 3] = Math.round(outA * 255);
        }
    }
    return { data: out, width: base.width, height: base.height };
}

function ensureAlpha({ data, width, height }) {
    return { data, width, height };
}

function removeAlpha({ data, width, height }) {
    for (let i = 3; i < data.length; i += 4) {
        data[i] = 255;
    }
    return { data, width, height };
}

function detectAlphaUsage({ data }) {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

function computeStats({ data }) {
    let r = 0, g = 0, b = 0, a = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
    }
    return {
        channels: [
            { mean: r / pixels },
            { mean: g / pixels },
            { mean: b / pixels },
            { mean: a / pixels }
        ]
    };
}

export {
    crop, resizeBilinear, resizeSmooth, resizeCover, resizeContain,
    grayscale, flip, flop, rotate90,
    negate, normalize, tint, blur, sharpen, extend, trim, composite,
    ensureAlpha, removeAlpha, detectAlphaUsage, computeStats
};
