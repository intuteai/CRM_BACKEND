const request = require('supertest');
const app = require('../server');

describe('Auth API', () => {
  it('should sign up a new user', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('token');
  });

  it('should login an existing user', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
  });
});