// Photo references (models/operations/pdi/photoRefs.js): a save may send
// 'ref:sha256:<hex>' in place of an image the server already stores, and
// `?hashes=1` hands the hashes out. Found from production report 33
// (PDI 202610004): 49 photos / 15.8 MB re-uploaded in full on every save until
// the upload outlasted the app's timeout. Database mocked, as in
// tests/pdi_finalized_edit.test.js.
const mockState = { preReadRow: null, storedPhotos: [], updateRows: [], fullReportRow: null, queries: [] };
const mockQuery = jest.fn(async (sql, params) => {
  mockState.queries.push({ sql, params });
  if (/SELECT status, revision_no, data,/.test(sql)) return { rows: mockState.preReadRow ? [mockState.preReadRow] : [] };
  if (/^SELECT photos FROM pre_dispatch_inspection_reports WHERE report_id = \$1$/.test(sql.trim())) return { rows: [{ photos: mockState.storedPhotos }] };
  if (/WHERE report_id = \$\d+ AND status <> 'Completed'/.test(sql)) return { rows: mockState.updateRows, rowCount: mockState.updateRows.length };
  if (/INSERT INTO pre_dispatch_inspection_reports/.test(sql)) return { rows: [mockState.fullReportRow] };
  if (/report_id, sr_no, customer_id[\s\S]*FROM pre_dispatch_inspection_reports WHERE report_id/.test(sql)) {
    return { rows: mockState.fullReportRow ? [mockState.fullReportRow] : [] };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a), connect: jest.fn() }));
jest.mock('../services/googleDrive', () => ({ uploadBufferToDrivePrivate: jest.fn(), deleteDriveFile: jest.fn() }));

const PdiReports = require('../models/operations/pdiReports');
const { hashImage, hasRefs, resolveRefs, summaryWithHashes, REF_PREFIX } = require('../models/operations/pdi/photoRefs');

const IMG = (n) => `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD#${n}`;
const ref = (image) => `${REF_PREFIX}${hashImage(image)}`;
const row = (photos, extra = {}) => ({
  report_id: 33, sr_no: 33, customer_id: null, order_id: null, status: 'In Progress',
  inspected_by: null, inspection_date: null, template_id: 'general', template_version: null,
  drive_file_id: null, revision_no: 58, batch_id: null, lot_index: null, batch: null,
  data: { pdi_no: '202610004' }, photos, ...extra,
});
const photosParam = () => {
  const update = mockState.queries.find((q) => /UPDATE pre_dispatch_inspection_reports/.test(q.sql));
  const index = Number(update.sql.match(/photos = CASE WHEN photos = \$(\d+)::jsonb/)[1]);
  return JSON.parse(update.params[index - 1]);
};

beforeEach(() => {
  mockQuery.mockClear();
  mockState.queries = [];
  mockState.preReadRow = { status: 'In Progress', revision_no: 57, data: { pdi_no: '202610004' }, batch_status: null };
  mockState.storedPhotos = [
    { id: 'name-plate', label: 'Name plate', images: [IMG(1), IMG(2)] },
    { id: 'overall', label: 'Overall photo', images: [IMG(3)] },
  ];
  mockState.updateRows = [row([{ id: 'name-plate', label: 'Name plate', image_count: 2 }, { id: 'overall', label: 'Overall photo', image_count: 2 }])];
  mockState.fullReportRow = row(mockState.storedPhotos);
});

describe('photoRefs helpers', () => {
  it('hashes the image string exactly as stored (SHA-256, lowercase hex)', () => {
    expect(hashImage('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashImage(IMG(1))).toMatch(/^[0-9a-f]{64}$/);
    expect(hashImage(IMG(1))).not.toBe(hashImage(IMG(2)));
  });

  it('spots a reference in either stored shape, and none in plain photos', () => {
    expect(hasRefs([{ id: 'a', images: [IMG(1)] }])).toBe(false);
    expect(hasRefs([{ id: 'a', images: [IMG(1), ref(IMG(2))] }])).toBe(true);
    expect(hasRefs({ front: ref(IMG(1)) })).toBe(true);
    expect(hasRefs({ front: IMG(1), back: [IMG(2)] })).toBe(false);
    expect(hasRefs(undefined)).toBe(false);
    expect(hasRefs(null)).toBe(false);
    expect(hasRefs([])).toBe(false);
  });

  it('swaps references for the stored images and leaves new images alone', () => {
    const incoming = [
      { id: 'name-plate', label: 'Name plate', images: [ref(IMG(1)), ref(IMG(2))] },
      { id: 'overall', label: 'Overall photo', images: [ref(IMG(3)), IMG(4)] },
    ];
    expect(resolveRefs(incoming, mockState.storedPhotos)).toEqual([
      { id: 'name-plate', label: 'Name plate', images: [IMG(1), IMG(2)] },
      { id: 'overall', label: 'Overall photo', images: [IMG(3), IMG(4)] },
    ]);
  });

  it('follows the reference, not the position: photos can move between entries, be reordered or dropped', () => {
    const incoming = [
      { id: 'overall', label: 'Renamed', images: [ref(IMG(2))] },
      { id: 'new-entry', label: 'New', images: [ref(IMG(3)), ref(IMG(3))] },
    ];
    expect(resolveRefs(incoming, mockState.storedPhotos)).toEqual([
      { id: 'overall', label: 'Renamed', images: [IMG(2)] },
      { id: 'new-entry', label: 'New', images: [IMG(3), IMG(3)] },
    ]);
  });

  it('resolves against a stored fixed-slots map and an older { image } entry', () => {
    expect(resolveRefs([{ id: 'a', images: [ref(IMG(7)), ref(IMG(8))] }], { front: IMG(7), back: [IMG(8)], empty: null }))
      .toEqual([{ id: 'a', images: [IMG(7), IMG(8)] }]);
    expect(resolveRefs([{ id: 'a', images: [ref(IMG(9))] }], [{ id: 'old', image: IMG(9) }]))
      .toEqual([{ id: 'a', images: [IMG(9)] }]);
  });

  it('refuses a reference the server does not hold, and says how many', () => {
    const incoming = [{ id: 'a', images: [ref(IMG(1)), ref(IMG(98)), ref(IMG(99))] }];
    expect(() => resolveRefs(incoming, mockState.storedPhotos)).toThrow(expect.objectContaining({
      code: 'PHOTO_REF_NOT_FOUND',
      message: '2 photos referenced by this save are no longer on the server. Send the photos themselves.',
    }));
    expect(() => resolveRefs([{ id: 'a', images: [ref(IMG(98))] }], [])).toThrow(expect.objectContaining({ code: 'PHOTO_REF_NOT_FOUND' }));
    expect(() => resolveRefs([{ id: 'a', images: [ref(IMG(98))] }], null)).toThrow(expect.objectContaining({ code: 'PHOTO_REF_NOT_FOUND' }));
  });

  it('refuses a malformed reference', () => {
    for (const bad of ['ref:sha256:', 'ref:sha256:xyz', `ref:sha256:${'A'.repeat(64)}`, `ref:sha256:${'a'.repeat(63)}`]) {
      expect(() => resolveRefs([{ id: 'a', images: [bad] }], mockState.storedPhotos)).toThrow(expect.objectContaining({ code: 'INVALID_PHOTO_REF' }));
    }
  });

  it('does not change the incoming photos', () => {
    const incoming = [{ id: 'name-plate', images: [ref(IMG(1))] }];
    const before = JSON.stringify(incoming);
    resolveRefs(incoming, mockState.storedPhotos);
    expect(JSON.stringify(incoming)).toBe(before);
  });

  it('summaryWithHashes lists one hash per image, in order, and carries no image data', () => {
    const summary = summaryWithHashes(mockState.storedPhotos);
    expect(summary).toEqual([
      { id: 'name-plate', label: 'Name plate', image_count: 2, image_hashes: [hashImage(IMG(1)), hashImage(IMG(2))] },
      { id: 'overall', label: 'Overall photo', image_count: 1, image_hashes: [hashImage(IMG(3))] },
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/data:image/);
    expect(summaryWithHashes([{ id: 'a', label: 'No images' }, { id: 'b', images: [] }])).toEqual([
      { id: 'a', label: 'No images', image_count: 0, image_hashes: [] },
      { id: 'b', label: '', image_count: 0, image_hashes: [] },
    ]);
    expect(summaryWithHashes({ front: IMG(1), back: [IMG(2), IMG(3)], empty: null })).toEqual([
      { id: 'front', label: 'front', image_count: 1, image_hashes: [hashImage(IMG(1))] },
      { id: 'back', label: 'back', image_count: 2, image_hashes: [hashImage(IMG(2)), hashImage(IMG(3))] },
      { id: 'empty', label: 'empty', image_count: 0, image_hashes: [] },
    ]);
    expect(summaryWithHashes(null)).toEqual([]);
  });
});

describe('patchReport with photo references', () => {
  const withNewPhoto = () => [
    { id: 'name-plate', label: 'Name plate', images: [ref(IMG(1)), ref(IMG(2))] },
    { id: 'overall', label: 'Overall photo', images: [ref(IMG(3)), IMG(4)] },
  ];
  const complete = () => [
    { id: 'name-plate', label: 'Name plate', images: [IMG(1), IMG(2)] },
    { id: 'overall', label: 'Overall photo', images: [IMG(3), IMG(4)] },
  ];

  it('stores the complete photo set -- no reference ever reaches the database', async () => {
    await PdiReports.patchReport(33, { photos: withNewPhoto() }, null, { photosSummary: true });
    expect(photosParam()).toEqual(complete());
    expect(JSON.stringify(photosParam())).not.toMatch(/ref:sha256:/);
  });

  it('a save without references reads no stored photos (old apps and the web are unaffected)', async () => {
    await PdiReports.patchReport(33, { photos: complete() }, null, { photosSummary: true });
    expect(mockState.queries.some((q) => /^SELECT photos FROM/.test(q.sql.trim()))).toBe(false);
    expect(photosParam()).toEqual(complete());
  });

  it('an unknown reference fails the save before anything is written', async () => {
    const photos = [{ id: 'overall', label: 'Overall photo', images: [ref(IMG(77))] }];
    await expect(PdiReports.patchReport(33, { photos, data: { pdi_no: 'X' } }, null, { photosSummary: true }))
      .rejects.toMatchObject({ code: 'PHOTO_REF_NOT_FOUND' });
    expect(mockState.queries.some((q) => /UPDATE pre_dispatch_inspection_reports/.test(q.sql))).toBe(false);
  });

  const storedHashes = () => [
    { id: 'name-plate', label: 'Name plate', image_count: 2, image_hashes: [hashImage(IMG(1)), hashImage(IMG(2))] },
    { id: 'overall', label: 'Overall photo', image_count: 1, image_hashes: [hashImage(IMG(3))] },
  ];

  it('?hashes=1 answers with photo_hashes for what was just stored, and leaves photos alone', async () => {
    const saved = await PdiReports.patchReport(33, { photos: withNewPhoto() }, null, { photosSummary: true, photoHashes: true });
    expect(saved.photo_hashes).toEqual([
      { id: 'name-plate', label: 'Name plate', image_count: 2, image_hashes: [hashImage(IMG(1)), hashImage(IMG(2))] },
      { id: 'overall', label: 'Overall photo', image_count: 2, image_hashes: [hashImage(IMG(3)), hashImage(IMG(4))] },
    ]);
    expect(saved.photos).toEqual(mockState.updateRows[0].photos);
    expect(JSON.stringify(saved)).not.toMatch(/data:image/);
    // The stored photos were read once, to resolve the references -- not again for the hashes.
    expect(mockState.queries.filter((q) => /^SELECT photos FROM/.test(q.sql.trim()))).toHaveLength(1);
  });

  it('?hashes=1 on a save that sends no photos reports the hashes of the stored photos', async () => {
    const saved = await PdiReports.patchReport(33, { data: { pdi_no: 'Y' } }, null, { photosSummary: true, photoHashes: true });
    expect(saved.photo_hashes).toEqual(storedHashes());
  });

  it('without ?hashes=1 the response is exactly what it was', async () => {
    const saved = await PdiReports.patchReport(33, { photos: withNewPhoto() }, null, { photosSummary: true });
    expect(saved.photos).toEqual(mockState.updateRows[0].photos);
    expect(saved).not.toHaveProperty('photo_hashes');
  });

  it('?hashes=1 without a summary keeps the full photos and adds photo_hashes', async () => {
    mockState.updateRows = [row(complete())];
    const saved = await PdiReports.patchReport(33, { photos: withNewPhoto() }, null, { photoHashes: true });
    expect(saved.photos).toEqual(complete());
    expect(saved.photo_hashes[1].image_hashes).toEqual([hashImage(IMG(3)), hashImage(IMG(4))]);
  });
});

describe('getById and createReport', () => {
  const storedHashes = () => [
    { id: 'name-plate', label: 'Name plate', image_count: 2, image_hashes: [hashImage(IMG(1)), hashImage(IMG(2))] },
    { id: 'overall', label: 'Overall photo', image_count: 1, image_hashes: [hashImage(IMG(3))] },
  ];

  it('getById ?hashes=1 keeps photos as they were and adds photo_hashes, with or without a summary', async () => {
    const full = await PdiReports.getById(33, { photoHashes: true });
    expect(full.photos).toEqual(mockState.storedPhotos);
    expect(full.photo_hashes).toEqual(storedHashes());

    const summaryRow = [{ id: 'name-plate', label: 'Name plate', image_count: 2 }, { id: 'overall', label: 'Overall photo', image_count: 1 }];
    mockState.fullReportRow = row(summaryRow);
    const summary = await PdiReports.getById(33, { photosSummary: true, photoHashes: true });
    expect(summary.photos).toEqual(summaryRow);
    expect(summary.photo_hashes).toEqual(storedHashes());
    expect(JSON.stringify(summary)).not.toMatch(/data:image/);
  });

  it('getById without hashes is unchanged', async () => {
    const full = await PdiReports.getById(33);
    expect(full.photos).toEqual(mockState.storedPhotos);
    expect(full).not.toHaveProperty('photo_hashes');
  });

  it('a new report cannot carry a reference', async () => {
    await expect(PdiReports.createReport({ data: { pdi_no: 'N' }, photos: [{ id: 'a', images: [ref(IMG(1))] }] }, null))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_REF' });
    expect(mockState.queries.some((q) => /INSERT INTO pre_dispatch_inspection_reports/.test(q.sql))).toBe(false);
  });
});

// One step of a save that uploads its new photos a few at a time.
describe('patchReport photo_upload_step', () => {
  const updateSql = () => mockState.queries.find((q) => /UPDATE pre_dispatch_inspection_reports/.test(q.sql)).sql;
  const step = (extra = {}) => ({
    photo_upload_step: true,
    photos: [
      { id: 'name-plate', label: 'Name plate', images: [ref(IMG(1)), ref(IMG(2))] },
      { id: 'overall', label: 'Overall photo', images: [ref(IMG(3)), IMG(4)] },
    ],
    ...extra,
  });

  it('stores the photos and leaves the revision alone', async () => {
    await PdiReports.patchReport(33, step(), null, { photosSummary: true, photoHashes: true, expected_revision: 57 });
    expect(updateSql()).toMatch(/photos = CASE WHEN photos = /);
    expect(updateSql()).not.toMatch(/revision_no = revision_no \+ 1/);
    expect(photosParam()[1].images).toEqual([IMG(3), IMG(4)]);
  });

  it('an ordinary save still moves the revision on', async () => {
    await PdiReports.patchReport(33, { photos: step().photos }, null, { photosSummary: true });
    expect(updateSql()).toMatch(/revision_no = revision_no \+ 1/);
  });

  it('ignores every other field: a step never changes status, data or the inspector', async () => {
    await PdiReports.patchReport(33, step({ status: 'Failed', data: { pdi_no: 'CHANGED' }, inspected_by: 'X', inspection_date: '2026-10-09' }), null, { photosSummary: true });
    const sql = updateSql();
    for (const column of ['status =', 'data =', 'inspected_by =', 'inspection_date =', 'prepared_by =']) expect(sql.split('WHERE')[0]).not.toContain(column);
  });

  it('a status that would be refused on a save is not even looked at on a step', async () => {
    await expect(PdiReports.patchReport(33, step({ status: 'Completed' }), null, { photosSummary: true })).resolves.toBeDefined();
  });

  it('still honours expected_revision', async () => {
    await expect(PdiReports.patchReport(33, step(), null, { photosSummary: true, expected_revision: 56 }))
      .rejects.toMatchObject({ code: 'REPORT_VERSION_CONFLICT' });
    expect(mockState.queries.some((q) => /UPDATE pre_dispatch_inspection_reports/.test(q.sql))).toBe(false);
  });

  it('is refused on a finalized report', async () => {
    mockState.preReadRow = { status: 'Completed', revision_no: 57, data: {}, batch_status: null };
    await expect(PdiReports.patchReport(33, step(), null, { photosSummary: true, expected_revision: 57, role_id: 1 }))
      .rejects.toMatchObject({ code: 'REPORT_LOCKED' });
  });

  it('is refused for a unit of a lot that is no longer open', async () => {
    mockState.preReadRow = { status: 'In Progress', revision_no: 57, data: {}, batch_status: 'Finalizing' };
    await expect(PdiReports.patchReport(33, step(), null, { photosSummary: true })).rejects.toMatchObject({ code: 'BATCH_MEMBER_LOCKED' });
  });

  it('must carry photos', async () => {
    await expect(PdiReports.patchReport(33, { photo_upload_step: true, data: { pdi_no: 'X' } }, null, {}))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_UPLOAD_STEP' });
    await expect(PdiReports.patchReport(33, { photo_upload_step: true, photos: null }, null, {}))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_UPLOAD_STEP' });
  });

  it('only the exact value true makes a step', async () => {
    await PdiReports.patchReport(33, { photo_upload_step: 'true', photos: step().photos, data: { pdi_no: 'Y' } }, null, { photosSummary: true });
    expect(updateSql()).toMatch(/revision_no = revision_no \+ 1/);
    expect(updateSql()).toMatch(/data = /);
  });
});

describe('createReport ?hashes=1', () => {
  it('answers with photo_hashes for the photos the new report was given, and with none when it has none', async () => {
    const created = await PdiReports.createReport({ data: { pdi_no: 'N' }, photos: mockState.storedPhotos }, null, { photoHashes: true });
    expect(created.photos).toEqual(mockState.storedPhotos);
    expect(created.photo_hashes).toEqual([
      { id: 'name-plate', label: 'Name plate', image_count: 2, image_hashes: [hashImage(IMG(1)), hashImage(IMG(2))] },
      { id: 'overall', label: 'Overall photo', image_count: 1, image_hashes: [hashImage(IMG(3))] },
    ]);

    mockState.fullReportRow = row([]);
    const empty = await PdiReports.createReport({ data: { pdi_no: 'N' } }, null, { photoHashes: true });
    expect(empty.photo_hashes).toEqual([]);
  });

  it('without the option the response is exactly what it was', async () => {
    const created = await PdiReports.createReport({ data: { pdi_no: 'N' }, photos: mockState.storedPhotos }, null);
    expect(created).not.toHaveProperty('photo_hashes');
  });
});

// Found by review: a reference must not be storable in any shape or place.
describe('a reference can never be stored', () => {
  const noWrite = () => expect(mockState.queries.some((q) => /UPDATE pre_dispatch_inspection_reports|INSERT INTO pre_dispatch_inspection_reports/.test(q.sql))).toBe(false);
  const R = () => ref(IMG(1));

  it.each([
    ['images is a string, not a list', () => [{ id: 'a', images: R() }]],
    ['a list inside the list', () => [{ id: 'a', images: [[R()]] }]],
    ['an object in place of an image', () => [{ id: 'a', images: [{ uri: R() }] }]],
    ['photos is a bare list of strings', () => [R()]],
    ['photos is a bare string', () => R()],
    ['a map slot holding an object', () => ({ front: { uri: R() } })],
    ['a map slot holding a nested list', () => ({ front: [[R()]] })],
    ['an entry key other than image or images', () => [{ id: 'a', images: [], thumbnail: R() }]],
    ['a leading space', () => [{ id: 'a', images: [` ${R()}`] }]],
    ['upper case', () => [{ id: 'a', images: [R().toUpperCase()] }]],
  ])('PATCH refuses %s', async (_name, photos) => {
    await expect(PdiReports.patchReport(33, { photos: photos() }, null, { photosSummary: true }))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_REF' });
    noWrite();
  });

  it('PATCH refuses a malformed reference before anything is written', async () => {
    await expect(PdiReports.patchReport(33, { photos: [{ id: 'a', images: ['ref:sha256:xyz'] }], data: { pdi_no: 'X' } }, null, {}))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_REF' });
    noWrite();
  });

  it('PATCH refuses a reference inside data, where an authored template may keep a photo section', async () => {
    await expect(PdiReports.patchReport(33, { data: { damage_photos: [{ id: 'd', images: [R()] }] } }, null, {}))
      .rejects.toMatchObject({ code: 'INVALID_PHOTO_REF' });
    noWrite();
  });

  it('POST refuses a reference in photos, in any shape, and in data', async () => {
    for (const body of [
      { photos: [{ id: 'a', images: [[R()]] }] },
      { photos: { front: { uri: R() } } },
      { data: { damage_photos: [{ images: [R()] }] } },
    ]) {
      await expect(PdiReports.createReport(body, null)).rejects.toMatchObject({ code: 'INVALID_PHOTO_REF' });
    }
    noWrite();
  });

  it('ordinary text that merely mentions a reference is left alone', async () => {
    await expect(PdiReports.patchReport(33, { data: { remarks: 'see ref:sha256: in the manual', pdi_no: 'X' } }, null, {})).resolves.toBeDefined();
  });
});

describe('every hash handed out can be resolved', () => {
  it.each([
    ['an empty string in a list', () => [{ id: 'a', images: ['', IMG(1)] }]],
    ['null in a list', () => [{ id: 'a', images: [null, IMG(1)] }]],
    ['a number in a list', () => [{ id: 'a', images: [5] }]],
    ['an empty string in a map slot', () => ({ front: '', back: [IMG(2)] })],
  ])('%s', (_name, makeStored) => {
    const stored = makeStored();
    const hashes = summaryWithHashes(stored).flatMap((entry) => entry.image_hashes);
    expect(hashes.length).toBeGreaterThan(0);
    const incoming = [{ id: 'all', images: hashes.map((hash) => `${REF_PREFIX}${hash}`) }];
    expect(() => resolveRefs(incoming, stored)).not.toThrow();
    expect(resolveRefs(incoming, stored)[0].images).toHaveLength(hashes.length);
  });
});

describe('references through patchReport, remaining cases', () => {
  it('resolves references in a fixed-slots map against a stored map', async () => {
    mockState.storedPhotos = { front: IMG(1), back: [IMG(2), IMG(3)], side: null };
    await PdiReports.patchReport(33, { photos: { front: ref(IMG(1)), back: [ref(IMG(3)), IMG(4)], side: ref(IMG(2)) } }, null, { photosSummary: true });
    expect(photosParam()).toEqual({ front: IMG(1), back: [IMG(3), IMG(4)], side: IMG(2) });
  });

  it('a photo step keeps the revision guard and the lot guard in its UPDATE', async () => {
    await PdiReports.patchReport(33, { photo_upload_step: true, photos: [{ id: 'a', images: [IMG(9)] }] }, null, { photosSummary: true, expected_revision: 57 });
    const update = mockState.queries.find((q) => /UPDATE pre_dispatch_inspection_reports/.test(q.sql));
    expect(update.sql).toMatch(/AND status <> 'Completed' AND revision_no = \$\d+/);
    expect(update.sql).toMatch(/pdi_report_batches/);
    expect(update.params).toContain(57);
  });

  it('a photo step may empty the photos, and works on a Failed report', async () => {
    mockState.preReadRow = { status: 'Failed', revision_no: 57, data: {}, batch_status: null };
    await PdiReports.patchReport(33, { photo_upload_step: true, photos: [] }, null, { photosSummary: true });
    expect(photosParam()).toEqual([]);
  });

  it('on a finalized report, someone without permission learns nothing about which photos are stored', async () => {
    mockState.preReadRow = { status: 'Completed', revision_no: 57, data: {}, batch_status: null };
    for (const image of [IMG(1), IMG(404)]) {
      await expect(PdiReports.patchReport(33, { photos: [{ id: 'a', images: [ref(image)] }] }, null, { role_id: 9, expected_revision: 57 }))
        .rejects.toMatchObject({ code: 'FINALIZED_REPORT_FORBIDDEN' });
    }
    expect(mockState.queries.some((q) => /^SELECT photos FROM/.test(q.sql.trim()))).toBe(false);
  });
});
