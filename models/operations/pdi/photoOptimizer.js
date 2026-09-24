'use strict';

const logger = require('../../../utils/logger');

// Photos reach the PDF as data-URIs already resized by the phone/web client to
// about 1600x1200 (300-500 KB each). In the PDF a photo is printed roughly 9 cm
// wide, so that resolution is far more than the page can show, and PDFKit
// embeds a JPEG byte-for-byte -- so a 60-photo report produced a ~21 MB PDF
// that the phone then had to download. Measured against 60 realistic photos:
// resizing to 1000 px / JPEG q70 costs ~22 ms per photo on the server and
// shrinks the PDF 21.6 MB -> 8.1 MB (about 275 dpi at print size).
const MAX_EDGE = 1000;
const JPEG_QUALITY = 70;
// sharp decodes each image to raw pixels (1600x1200x3 ~ 5.8 MB), so cap how
// many are in flight at once -- 60 at a time would be ~350 MB on a small host.
const CONCURRENCY = 4;

const DATA_URI = /^data:image\/(png|jpe?g);base64,([a-z0-9+/=\s]+)$/i;

// sharp is a native module. If it can't load (e.g. a container build without
// its binary), every photo is left exactly as it arrived -- the PDF is just
// bigger, never broken.
let sharp = null;
let sharpLoadError = null;
try {
  sharp = require('sharp');
} catch (e) {
  sharpLoadError = e;
  logger.warn(`PDI photo optimizer disabled, sharp failed to load: ${e.message}`);
}

async function optimizeDataUri(uri) {
  if (!sharp || typeof uri !== 'string') return uri;
  const match = DATA_URI.exec(uri);
  if (!match) return uri;
  try {
    const original = Buffer.from(match[2], 'base64');
    const resized = await sharp(original, { failOn: 'none' })
      .rotate() // PDFKit ignores EXIF orientation, so bake it in
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // a PNG's transparency has no meaning in a JPEG
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    // Never make a photo bigger (e.g. an already-small, already-compressed one).
    if (resized.length >= original.length) return uri;
    return `data:image/jpeg;base64,${resized.toString('base64')}`;
  } catch (e) {
    // A photo sharp can't read still goes to PDFKit unchanged, which either
    // embeds it or draws the empty placeholder, as it always did.
    logger.warn(`PDI photo not optimized, keeping original: ${e.message}`);
    return uri;
  }
}

// Runs `fn` over `items` with at most `limit` in flight, preserving order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// The data keys a template draws photos from: every 'photo' section's dataKey,
// across all pages (general/autonxt use 'photos'; an authored template can name
// its own).
function photoDataKeys(template) {
  const keys = new Set();
  (template?.pages || []).forEach((page) => (page.sections || []).forEach((section) => {
    if (section.type === 'photo' && section.dataKey) keys.add(section.dataKey);
  }));
  return [...keys];
}

// Returns a copy of `data` whose photo values are optimized, in the same shapes
// the renderer reads: a freeform list [{ label, images: [uri] }] or a
// fixed-slots map { slotKey: uri | [uri] | null }. `stats`, if given, is filled
// with { photos, bytesBefore, bytesAfter, ms } for the timing log.
async function optimizePhotoData(template, data, stats) {
  const started = Date.now();
  const keys = photoDataKeys(template).filter((k) => data && data[k]);
  if (!sharp || keys.length === 0) {
    if (stats) Object.assign(stats, { photos: 0, bytesBefore: 0, bytesAfter: 0, ms: 0, skipped: !sharp });
    return data;
  }

  // Collect every data-URI in place (remembering where it goes back), optimize
  // them all through one bounded pool, then rebuild the same structure.
  const out = { ...data };
  const slots = []; // { set(uri), uri }
  keys.forEach((key) => {
    const value = data[key];
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (!entry || !Array.isArray(entry.images)) return entry;
        const copy = { ...entry, images: [...entry.images] };
        copy.images.forEach((uri, i) => slots.push({ uri, set: (v) => { copy.images[i] = v; } }));
        return copy;
      });
    } else if (value && typeof value === 'object') {
      const copy = { ...value };
      Object.keys(copy).forEach((slotKey) => {
        const v = copy[slotKey];
        if (Array.isArray(v)) {
          const list = [...v];
          list.forEach((uri, i) => slots.push({ uri, set: (nv) => { list[i] = nv; } }));
          copy[slotKey] = list;
        } else if (typeof v === 'string') {
          slots.push({ uri: v, set: (nv) => { copy[slotKey] = nv; } });
        }
      });
      out[key] = copy;
    }
  });

  const before = slots.reduce((sum, s) => sum + (typeof s.uri === 'string' ? s.uri.length : 0), 0);
  const optimized = await mapLimit(slots, CONCURRENCY, (s) => optimizeDataUri(s.uri));
  optimized.forEach((uri, i) => slots[i].set(uri));
  const after = optimized.reduce((sum, u) => sum + (typeof u === 'string' ? u.length : 0), 0);

  if (stats) Object.assign(stats, { photos: slots.length, bytesBefore: before, bytesAfter: after, ms: Date.now() - started, skipped: false });
  return out;
}

module.exports = { optimizePhotoData, optimizeDataUri, photoDataKeys, MAX_EDGE, JPEG_QUALITY, sharpLoadError };
