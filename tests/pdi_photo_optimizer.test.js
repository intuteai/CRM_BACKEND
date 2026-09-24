// PDF photo downscaling (backend-performance-v1.0.8.md item 2.1). Photos reach
// the PDF already resized by the client to ~1600x1200; PDFKit embeds a JPEG
// byte-for-byte, so a 60-photo report made a ~21 MB PDF the phone had to
// download. No database, no network.
const crypto = require('crypto');
const sharp = require('sharp');
const { optimizeDataUri, optimizePhotoData, MAX_EDGE } = require('../models/operations/pdi/photoOptimizer');
const PDIGenerator = require('../models/operations/pdi_generator');

// Random noise is the worst case for JPEG (it doesn't compress), so it stands
// in for a detailed real photo: a big, realistic-sized input.
async function noisyJpegUri(width = 1600, height = 1200, quality = 85) {
  const raw = crypto.randomBytes(width * height * 3);
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const dimsOf = async (uri) => {
  const m = await sharp(Buffer.from(uri.split(',')[1], 'base64')).metadata();
  return { width: m.width, height: m.height, format: m.format };
};

describe('optimizeDataUri', () => {
  it('downscales a large photo to fit MAX_EDGE and makes it smaller', async () => {
    const original = await noisyJpegUri();
    const out = await optimizeDataUri(original);
    const { width, height, format } = await dimsOf(out);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_EDGE);
    expect(format).toBe('jpeg');
    expect(out.length).toBeLessThan(original.length);
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('keeps the aspect ratio (4:3 stays 4:3)', async () => {
    const out = await optimizeDataUri(await noisyJpegUri(1600, 1200));
    const { width, height } = await dimsOf(out);
    expect(width / height).toBeCloseTo(4 / 3, 1);
  });

  it('never makes a photo bigger -- an already tiny, heavily compressed one is returned as it came', async () => {
    const tiny = await noisyJpegUri(120, 90, 15);
    expect(await optimizeDataUri(tiny)).toBe(tiny);
  });

  it('accepts a PNG and returns a JPEG, without throwing on its transparency', async () => {
    const raw = crypto.randomBytes(1400 * 1000 * 4);
    const png = await sharp(raw, { raw: { width: 1400, height: 1000, channels: 4 } }).png().toBuffer();
    const out = await optimizeDataUri(`data:image/png;base64,${png.toString('base64')}`);
    expect((await dimsOf(out)).format).toBe('jpeg');
  });

  it('leaves anything that is not a JPEG/PNG data-URI alone', async () => {
    for (const v of [null, undefined, '', 'https://x/y.jpg', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 42]) {
      expect(await optimizeDataUri(v)).toBe(v);
    }
  });

  it('keeps a photo it cannot decode instead of throwing', async () => {
    const corrupt = 'data:image/jpeg;base64,AAAAAAAAAAAAAAAAAAAA';
    await expect(optimizeDataUri(corrupt)).resolves.toBe(corrupt);
  });
});

describe('optimizePhotoData', () => {
  const generalLike = { pages: [{ sections: [{ type: 'photo', mode: 'freeform', dataKey: 'photos' }] }] };
  const slotsLike = { pages: [{ sections: [{ type: 'photo', mode: 'fixed-slots', dataKey: 'slot_photos', slots: [] }] }] };

  it('optimizes a freeform photo list ({ label, images[] }) and leaves other data alone', async () => {
    const a = await noisyJpegUri();
    const b = await noisyJpegUri();
    const data = { pdi_no: 'X', drawing_image: a, photos: [{ id: 'p1', label: 'Overall', images: [a, b] }, { id: 'p2', label: '', images: [] }] };
    const stats = {};
    const out = await optimizePhotoData(generalLike, data, stats);
    expect(out.photos[0].images.every((u, i) => u.length < data.photos[0].images[i].length)).toBe(true);
    expect(out.photos[0].label).toBe('Overall');
    expect(out.photos[1].images).toEqual([]);
    expect(out.drawing_image).toBe(a); // not a photo section's key -> untouched
    expect(out.pdi_no).toBe('X');
    expect(stats.photos).toBe(2);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });

  it('optimizes a fixed-slots map whose slot holds a string, an array, or null', async () => {
    const a = await noisyJpegUri();
    const data = { slot_photos: { front: a, back: [a, a], empty: null } };
    const out = await optimizePhotoData(slotsLike, data);
    expect(out.slot_photos.front.length).toBeLessThan(a.length);
    expect(out.slot_photos.back).toHaveLength(2);
    expect(out.slot_photos.back[0].length).toBeLessThan(a.length);
    expect(out.slot_photos.empty).toBeNull();
  });

  it('does not mutate the report data it was given', async () => {
    const a = await noisyJpegUri();
    const data = { photos: [{ label: 'x', images: [a] }] };
    await optimizePhotoData(generalLike, data);
    expect(data.photos[0].images[0]).toBe(a);
  });

  it('is a no-op for a template with no photo section or a report with no photos', async () => {
    const data = { photos: [] };
    expect(await optimizePhotoData({ pages: [{ sections: [] }] }, data)).toBe(data);
    expect(await optimizePhotoData(generalLike, { pdi_no: 'X' })).toEqual({ pdi_no: 'X' });
  });
});

describe('when sharp cannot be loaded (e.g. a container without its native binary)', () => {
  it('passes every photo through unchanged instead of failing the PDF', async () => {
    let isolated;
    jest.isolateModules(() => {
      jest.doMock('sharp', () => { throw new Error('Could not load the "sharp" module'); });
      isolated = require('../models/operations/pdi/photoOptimizer');
    });
    const data = { photos: [{ label: 'x', images: ['data:image/jpeg;base64,AAAA'] }] };
    const stats = {};
    const out = await isolated.optimizePhotoData({ pages: [{ sections: [{ type: 'photo', dataKey: 'photos' }] }] }, data, stats);
    expect(out).toBe(data);
    expect(stats.skipped).toBe(true);
    expect(isolated.sharpLoadError).toBeTruthy();
    jest.dontMock('sharp');
  });
});

describe('PDIGenerator with photos', () => {
  it('produces a much smaller PDF than the raw photos, and reports the optimizer stats', async () => {
    const uris = await Promise.all([1, 2, 3, 4].map(() => noisyJpegUri()));
    const rawBytes = uris.reduce((s, u) => s + Buffer.from(u.split(',')[1], 'base64').length, 0);
    const timings = {};
    const doc = await PDIGenerator.generate('general', null, {
      pdi_no: 'PDI-PHOTO-OPT', customer_name: 'Unit',
      rows: [{ motor_sr_no: 'SR1' }],
      photos: [{ id: 'p1', label: 'Overall', images: uris }],
    }, { timings });
    const chunks = [];
    await new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', resolve); doc.on('error', reject); });
    const pdf = Buffer.concat(chunks);
    expect(pdf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeLessThan(rawBytes * 0.6);
    expect(timings.optimize.photos).toBe(4);
    expect(timings.optimize.bytesAfter).toBeLessThan(timings.optimize.bytesBefore);
  }, 30000);
});
