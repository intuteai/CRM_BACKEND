// hasPermission (extracted from checkPermission so a model method can call it
// directly, not just use it as route middleware -- see
// docs/superpowers/specs/2026-09-30-pdi-finalized-report-editing-design.md)
// and confirmation that checkPermission's own existing route-middleware
// behavior is completely unchanged. The database is mocked, so this touches
// no real data.
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));

const { hasPermission, checkPermission } = require('../middleware/auth');

describe('hasPermission', () => {
  beforeEach(() => mockQuery.mockClear());

  it('returns true when the role has the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    await expect(hasPermission(1, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT can_write FROM permissions WHERE role_id = $1 AND module = $2',
      [1, 'PreDispatchInspectionReports']
    );
  });

  it('returns false when no permission row exists for the role/module', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(hasPermission(99, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(false);
  });

  it('returns false when the row exists but the flag itself is false', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: false }] });
    await expect(hasPermission(2, 'PreDispatchInspectionReports', 'can_write')).resolves.toBe(false);
  });

  it('maps can_create to can_write, same column mapping checkPermission already had', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    await expect(hasPermission(1, 'Orders', 'can_create')).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT can_write FROM permissions WHERE role_id = $1 AND module = $2',
      [1, 'Orders']
    );
  });
});

describe('checkPermission middleware (behavior unchanged by the refactor)', () => {
  function mockRes() {
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  }

  beforeEach(() => mockQuery.mockClear());

  it('calls next() when the role has the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [{ can_write: true }] });
    const req = { user: { role_id: 1 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 403 PERM_DENIED when the role lacks the permission', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const req = { user: { role_id: 99 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Permission denied', code: 'PERM_DENIED' });
  });

  it('responds 403 PERM_DENIED when req.user is missing, without querying the database', async () => {
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('responds 500 PERM_CHECK_FAILED when the permission query itself fails', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));
    const req = { user: { role_id: 1 } };
    const res = mockRes();
    const next = jest.fn();
    await checkPermission('PreDispatchInspectionReports', 'can_write')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
