"""Compare PCSX2 screenshots without a third-party image library.

A memory poke that swaps a model is only proven by looking at the screen, so the loop
needs to answer "did the picture change, and is it the same picture as last time?"
automatically. That is a perceptual-hash job, and the repo's other test layers all run
on a bare interpreter — so this decodes PNG with `zlib` and hashes with arithmetic
rather than pulling in Pillow for sixty lines of work.

Scope is deliberately narrow: 8-bit non-interlaced greyscale/RGB/RGBA, which is what
PCSX2 writes. Anything else raises rather than guessing.
"""
import struct
import zlib

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

_CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


class PngError(RuntimeError):
    pass


def _chunks(data):
    if not data.startswith(PNG_MAGIC):
        raise PngError("not a PNG (bad signature)")
    pos = len(PNG_MAGIC)
    while pos + 8 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise PngError("truncated %s chunk" % ctype.decode("ascii", "replace"))
        yield ctype, body
        pos += 12 + length  # length + type + body + crc


def _unfilter(raw, width, height, bpp):
    """Reverse the per-scanline PNG filters. `bpp` is bytes per pixel."""
    stride = width * bpp
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        if pos >= len(raw):
            raise PngError("truncated image data")
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        if len(line) != stride:
            raise PngError("truncated scanline %d" % y)
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        else:
            raise PngError("unknown filter type %d on scanline %d" % (ftype, y))
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return bytes(out)


def decode_gray(data):
    """Decode a PNG to (width, height, greyscale bytes)."""
    width = height = depth = ctype = None
    idat = []
    for name, body in _chunks(data):
        if name == b"IHDR":
            width, height, depth, ctype, comp, filt, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8:
                raise PngError("only 8-bit PNGs supported (got %d-bit)" % depth)
            if ctype not in _CHANNELS:
                raise PngError("unsupported colour type %d (palettes not supported)" % ctype)
            if comp != 0 or filt != 0:
                raise PngError("unsupported compression/filter method")
            if interlace != 0:
                raise PngError("interlaced PNGs not supported")
        elif name == b"IDAT":
            idat.append(body)
        elif name == b"IEND":
            break
    if width is None:
        raise PngError("no IHDR chunk")
    if not idat:
        raise PngError("no IDAT chunk")

    nch = _CHANNELS[ctype]
    pixels = _unfilter(zlib.decompress(b"".join(idat)), width, height, nch)

    gray = bytearray(width * height)
    if nch == 1:
        gray[:] = pixels
    elif nch == 2:  # grey + alpha
        gray[:] = pixels[0::2]
    else:  # RGB / RGBA — Rec. 601 luma, integer maths
        for i in range(width * height):
            r = pixels[i * nch]
            g = pixels[i * nch + 1]
            b = pixels[i * nch + 2]
            gray[i] = (r * 299 + g * 587 + b * 114) // 1000
    return width, height, bytes(gray)


def _resize_gray(gray, width, height, nw, nh):
    """Box-average down to nw x nh. Averaging (rather than sampling one pixel) keeps the
    hash stable against the one-pixel jitter you get between two emulator runs."""
    out = bytearray(nw * nh)
    for y in range(nh):
        y0 = y * height // nh
        y1 = max(y0 + 1, (y + 1) * height // nh)
        for x in range(nw):
            x0 = x * width // nw
            x1 = max(x0 + 1, (x + 1) * width // nw)
            total = count = 0
            for sy in range(y0, y1):
                row = sy * width
                total += sum(gray[row + x0:row + x1])
                count += x1 - x0
            out[y * nw + x] = total // count
    return bytes(out)


def dhash(data, size=8):
    """64-bit difference hash of a PNG: compare each pixel with its right neighbour in a
    (size+1) x size thumbnail. Robust to brightness shifts, sensitive to shape — which
    is exactly the trade you want when asking "is a different character standing here?"
    """
    width, height, gray = decode_gray(data)
    small = _resize_gray(gray, width, height, size + 1, size)
    bits = 0
    for y in range(size):
        row = y * (size + 1)
        for x in range(size):
            bits = (bits << 1) | (1 if small[row + x] < small[row + x + 1] else 0)
    return bits


def hamming(a, b):
    return bin(a ^ b).count("1")


def dhash_file(path, size=8):
    with open(path, "rb") as f:
        return dhash(f.read(), size=size)


def distance(path_a, path_b, size=8):
    """Perceptual distance between two screenshots, 0 (identical) to size*size."""
    return hamming(dhash_file(path_a, size), dhash_file(path_b, size))


# Below this, two frames are the same scene as far as a swap test is concerned; the
# residual comes from animation, particles and dithering rather than a different model.
SAME_SCENE = 6


def changed(path_a, path_b, threshold=SAME_SCENE, size=8):
    return distance(path_a, path_b, size) > threshold
