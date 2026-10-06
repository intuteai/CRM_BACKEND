// A database failure while loading the user must not look like a bad token:
// the web and mobile clients log the user out on AUTH_INVALID_TOKEN.
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...args) => mockQuery(...args) }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));

const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');

const run = async () => {
  const req = { headers: { authorization: 'Bearer abc' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await authenticateToken(req, res, next);
  return { req, res, next };
};

describe('authenticateToken', () => {
  beforeEach(() => { mockQuery.mockReset(); jwt.verify.mockReset(); });

  it('returns 503 AUTH_UNAVAILABLE when the user lookup fails', async () => {
    jwt.verify.mockReturnValue({ user_id: 1 });
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const { res, next } = await run();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_UNAVAILABLE' }));
  });

  it('still returns 403 AUTH_INVALID_TOKEN for a bad token', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });
    const { res } = await run();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_INVALID_TOKEN' }));
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('passes a valid token through with the user attached', async () => {
    jwt.verify.mockReturnValue({ user_id: 1 });
    mockQuery.mockResolvedValue({ rows: [{ user_id: 1, name: 'Production', role_id: 5, role_name: 'Production' }] });
    const { req, next } = await run();
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ user_id: 1, role_id: 5, role_name: 'production' });
  });
});
