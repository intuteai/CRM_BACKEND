// Activities must stay inside the organization that owns them: a Compage
// user can never open, edit or delete an Intute AI activity, or the other
// way round, and a Compage employee may only update activities assigned to
// them. Model and cache are mocked, so no database is touched.
const mockActivities = {
  getAccess: jest.fn(),
  getById: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  create: jest.fn(),
  getAll: jest.fn(),
};
jest.mock('../models/operations/activities', () => mockActivities);
jest.mock('../config/redis', () => ({
  get: jest.fn().mockResolvedValue(null),
  setEx: jest.fn().mockResolvedValue(),
  del: jest.fn().mockResolvedValue(),
  scanIterator: async function* () {},
}));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const controller = require('../controllers/operations/activities.controller');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}
const req = (role_id, user_id, extra = {}) => ({ user: { role_id, user_id }, params: { id: '7' }, query: {}, body: {}, io: {}, ...extra });

beforeEach(() => jest.clearAllMocks());

describe('activities: cross-organization access', () => {
  it('Intute AI HR gets 404 for a Compage activity, and nothing is read', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'com', assignee_ids: [] });
    const res = mockRes();
    await controller.getOne(req(12, 50), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockActivities.getById).not.toHaveBeenCalled();
  });

  it('Compage HR cannot update an Intute AI activity', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'ia', assignee_ids: [] });
    const res = mockRes();
    await controller.update(req(10, 40, { body: { summary: 'x' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockActivities.update).not.toHaveBeenCalled();
  });

  it('Compage HR cannot delete an Intute AI activity', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'ia', assignee_ids: [] });
    const res = mockRes();
    await controller.delete(req(10, 40), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockActivities.delete).not.toHaveBeenCalled();
  });

  it('a missing activity is also 404', async () => {
    mockActivities.getAccess.mockResolvedValue(null);
    const res = mockRes();
    await controller.getOne(req(10, 40), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('same-organization access still works', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'ia', assignee_ids: [] });
    mockActivities.getById.mockResolvedValue({ id: 7, org: 'ia' });
    const res = mockRes();
    await controller.getOne(req(11, 60), res);
    expect(res.json).toHaveBeenCalledWith({ id: 7, org: 'ia' });
  });
});

describe('activities: Compage employee limits', () => {
  it('cannot open an activity they are not assigned to', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'com', assignee_ids: [99] });
    const res = mockRes();
    await controller.getOne(req(9, 30), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('cannot change the status of an activity they are not assigned to', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'com', assignee_ids: [99] });
    const res = mockRes();
    await controller.update(req(9, 30, { body: { status: 'done' } }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockActivities.update).not.toHaveBeenCalled();
  });

  it('can change the status of their own activity', async () => {
    mockActivities.getAccess.mockResolvedValue({ org: 'com', assignee_ids: [30] });
    mockActivities.update.mockResolvedValue({ id: 7, status: 'done' });
    const res = mockRes();
    await controller.update(req(9, 30, { body: { status: 'done' } }), res);
    expect(mockActivities.update).toHaveBeenCalledWith('7', { status: 'done' }, expect.anything());
    expect(res.json).toHaveBeenCalledWith({ id: 7, status: 'done' });
  });
});
