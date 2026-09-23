jest.mock('../models/sales/enquiry');
jest.mock('../config/redis', () => ({
  keys: jest.fn(async () => []),
  del: jest.fn(async () => {}),
  get: jest.fn(async () => null),
  setEx: jest.fn(async () => {}),
}));
jest.mock('../config/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/googleDrive', () => ({
  uploadBufferToDrive: jest.fn(async () => ({ directUrl: 'https://drive.google.com/uc?export=view&id=fake' })),
}));

const Enquiry = require('../models/sales/enquiry');
const { uploadBufferToDrive } = require('../services/googleDrive');
const controller = require('../controllers/sales/enquiry.controller');

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('enquiry.controller.create — representative self-assignment default', () => {
  beforeEach(() => {
    Enquiry.create.mockReset();
    Enquiry.create.mockResolvedValue({ enquiry_id: 'ENQ1' });
  });

  it('defaults assigned_to to the creating user when a representative omits it', async () => {
    const req = {
      body: { company_name: 'Acme' },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    expect(Enquiry.create).toHaveBeenCalledTimes(1);
    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBe(42);
  });

  it('does not force assigned_to for a sales user', async () => {
    const req = {
      body: { company_name: 'Acme' },
      user: { user_id: 3, role_name: 'sales' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBeNull();
  });

  it('keeps an explicit assigned_to even for a representative', async () => {
    const req = {
      body: { company_name: 'Acme', assigned_to: 99 },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.create(req, res);

    const [payload] = Enquiry.create.mock.calls[0];
    expect(payload.assigned_to).toBe(99);
  });
});

describe('enquiry.controller.uploadPhoto / deletePhoto', () => {
  beforeEach(() => {
    Enquiry.appendPhoto.mockReset();
    Enquiry.removePhoto.mockReset();
    uploadBufferToDrive.mockClear();
  });

  it('uploads the file buffer to Drive and appends the returned URL', async () => {
    Enquiry.appendPhoto.mockResolvedValue({ enquiry_id: 'ENQ1', photos: ['https://drive.google.com/uc?export=view&id=fake'] });
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
      user: { user_id: 1, role_name: 'admin' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(uploadBufferToDrive).toHaveBeenCalledTimes(1);
    expect(Enquiry.appendPhoto).toHaveBeenCalledWith('ENQ1', 'https://drive.google.com/uc?export=view&id=fake', null, { user_id: 1, role_name: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.body.record.photos).toEqual(['https://drive.google.com/uc?export=view&id=fake']);
  });

  it('rejects a disallowed mime type without calling Drive', async () => {
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'application/pdf' },
      user: { user_id: 1, role_name: 'admin' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(uploadBufferToDrive).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('removes a photo url', async () => {
    Enquiry.removePhoto.mockResolvedValue({ enquiry_id: 'ENQ1', photos: [] });
    const req = { params: { id: 'ENQ1' }, body: { url: 'https://drive/x' }, user: { user_id: 1, role_name: 'admin' }, io: null };
    const res = makeRes();

    await controller.deletePhoto(req, res);

    expect(Enquiry.removePhoto).toHaveBeenCalledWith('ENQ1', 'https://drive/x', null, { user_id: 1, role_name: 'admin' });
    expect(res.statusCode).toBe(200);
  });
});

describe('enquiry.controller.uploadPhoto — ownership enforcement', () => {
  it('returns 403 when the model rejects the mutation as Forbidden', async () => {
    Enquiry.appendPhoto.mockReset();
    Enquiry.appendPhoto.mockRejectedValue(new Error('Forbidden'));
    const req = {
      params: { id: 'ENQ1' },
      file: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
      user: { user_id: 42, role_name: 'representative' },
      io: null,
    };
    const res = makeRes();

    await controller.uploadPhoto(req, res);

    expect(res.statusCode).toBe(403);
  });
});
