const crypto = require('crypto');

// Photo references: a save may send 'ref:sha256:<hex>' in place of an image
// the server already stores, so a client that adds one photo to a report
// holding fifty uploads one photo instead of all fifty-one.
//
// Measured on production before this existed: report 33 (PDI 202610004) held
// 49 photos / 15.8 MB and was re-uploaded in full on each of its 57 saves; the
// save carrying the 50th photo outlasted the app's timeout on the factory
// connection.
//
// The hash is SHA-256 of the image string exactly as stored (the whole
// 'data:image/...;base64,...' text, UTF-8). The server hands hashes out as
// `photo_hashes` with `?hashes=1`, so a client never has to compute one.
const REF_PREFIX = 'ref:sha256:';
const REF_PATTERN = /^ref:sha256:[0-9a-f]{64}$/;
// Anything a client could have meant as a reference, however it is spelled.
const REF_LIKE = /^\s*ref:sha256:/i;

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function hashImage(image) {
  return crypto.createHash('sha256').update(String(image), 'utf8').digest('hex');
}

const isRefLike = (value) => typeof value === 'string' && REF_LIKE.test(value);

// True when a reference-like string sits anywhere inside `value`, at any
// depth and under any key. Used both to decide whether a save carries
// references and to prove afterwards that none is left to be stored.
function hasRefs(value) {
  if (typeof value === 'string') return isRefLike(value);
  if (Array.isArray(value)) return value.some(hasRefs);
  if (value && typeof value === 'object') return Object.values(value).some(hasRefs);
  return false;
}

// The images of one stored entry, exactly as the summary counts them
// (photosSummarySql in pdiReports.js): every element of a list entry's
// `images`; for a fixed-slots map, every element of a list or the one string.
const listEntryImages = (slot) => (Array.isArray(slot?.images) ? slot.images : []);
const mapEntryImages = (value) => (Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []));

// Every image position in either stored shape: a freeform list of
// { images: [...] } entries (older rows: { image }), or a fixed-slots map of
// slot -> uri | [uri]. `visit(value)` returns the value to keep at that position.
function mapImages(photos, visit) {
  if (Array.isArray(photos)) {
    return photos.map((slot) => {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot;
      const next = { ...slot };
      if (Array.isArray(slot.images)) next.images = slot.images.map(visit);
      if (typeof slot.image === 'string') next.image = visit(slot.image);
      return next;
    });
  }
  if (photos && typeof photos === 'object') {
    return Object.fromEntries(Object.entries(photos).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(visit) : (typeof value === 'string' ? visit(value) : value),
    ]));
  }
  return photos;
}

// Replaces every reference in `incoming` with the stored image it names.
// Nothing is returned unless every reference resolves, so a reference can
// never reach the database.
function resolveRefs(incoming, stored) {
  // Indexed by the same rule summaryWithHashes hashes by, so every hash the
  // server hands out is one it can resolve.
  const byHash = new Map();
  const remember = (value) => { if (!isRefLike(value)) byHash.set(hashImage(value), value); };
  if (Array.isArray(stored)) {
    for (const slot of stored) {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
      listEntryImages(slot).forEach(remember);
      if (typeof slot.image === 'string') remember(slot.image);
    }
  } else if (stored && typeof stored === 'object') {
    for (const value of Object.values(stored)) mapEntryImages(value).forEach(remember);
  }

  let missing = 0;
  const resolved = mapImages(incoming, (value) => {
    if (!isRefLike(value)) return value;
    if (!REF_PATTERN.test(value)) {
      throw codedError('A photo reference in this save is not valid. Send the photo itself.', 'INVALID_PHOTO_REF');
    }
    const hash = value.slice(REF_PREFIX.length);
    if (!byHash.has(hash)) { missing += 1; return value; }
    return byHash.get(hash);
  });
  if (missing) {
    throw codedError(
      `${missing} photo${missing === 1 ? '' : 's'} referenced by this save ${missing === 1 ? 'is' : 'are'} no longer on the server. Send the photos themselves.`,
      'PHOTO_REF_NOT_FOUND'
    );
  }
  // A reference somewhere mapImages does not look (a nested list, an object
  // in place of an image, an unexpected key) was not resolved. Refuse it
  // rather than store it as if it were a photo.
  if (hasRefs(resolved)) {
    throw codedError('A photo reference in this save is not valid. Send the photo itself.', 'INVALID_PHOTO_REF');
  }
  return resolved;
}

// One entry per stored photo entry, in stored order, each with the hashes of
// its images in order -- the shape of photosSummarySql in pdiReports.js, plus
// image_hashes. No image data. For a fixed-slots map the entries follow this
// object's key order, which need not be the order the database lists them in:
// a client pairs a map's entries by `id`.
function summaryWithHashes(photos) {
  if (Array.isArray(photos)) {
    return photos
      .filter((slot) => slot && typeof slot === 'object' && !Array.isArray(slot))
      .map((slot) => {
        const images = listEntryImages(slot);
        return {
          id: typeof slot.id === 'string' ? slot.id : (slot.id == null ? '' : String(slot.id)),
          label: typeof slot.label === 'string' ? slot.label : (slot.label == null ? '' : String(slot.label)),
          image_count: images.length,
          image_hashes: images.map(hashImage),
        };
      });
  }
  if (photos && typeof photos === 'object') {
    return Object.entries(photos).map(([key, value]) => {
      const images = mapEntryImages(value);
      return { id: key, label: key, image_count: images.length, image_hashes: images.map(hashImage) };
    });
  }
  return [];
}

module.exports = { REF_PREFIX, hashImage, hasRefs, resolveRefs, summaryWithHashes };
