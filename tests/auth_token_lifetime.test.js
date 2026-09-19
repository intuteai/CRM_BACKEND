// Login token lifetime: the PDI mobile app (identified by its X-App-Version
// header) gets a 12h token, every other client keeps the 1h default.
// The database and password hashing are mocked, so this touches no real data.
jest.mock('../config/db', () => ({
  query: jest.fn(async () => ({
    rows: [{
      user_id: 1, role_id: 1, name: 'Admin', role_name: 'admin', password_hash: 'hash',
    }],
  })),
}));
jest.mock('bcryptjs', () => ({ compare: jest.fn(async () => true) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');

const lifetimeSeconds = (token) => {
  const { iat, exp } = jwt.decode(token);
  return exp - iat;
};

describe('Login token lifetime', () => {
  const credentials = { email: 'admin@example.com', password: 'password123' };

  it('gives the mobile app a 12 hour token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-App-Version', '1.0.1 (2)')
      .send(credentials);
    expect(res.statusCode).toBe(200);
    expect(lifetimeSeconds(res.body.token)).toBe(12 * 60 * 60);
  });

  it('keeps the 1 hour token for clients that do not send the app header', async () => {
    const res = await request(app).post('/api/auth/login').send(credentials);
    expect(res.statusCode).toBe(200);
    expect(lifetimeSeconds(res.body.token)).toBe(60 * 60);
  });
});
