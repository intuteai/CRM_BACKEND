const request = require('supertest');
const app = require('../server');

describe('Auth API', () => {
  let token;

  // Note: Assumes a signup route exists; adjust if it's in another file
  it('should sign up a new user', async () => {
    const res = await request(app)
      .post('/api/auth/signup') // Adjust path if signup is elsewhere
      .send({ name: 'Test User', email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('token');
  });

  it('should login an existing user', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    token = res.body.token; // Save token for next test
  });

  it('should update user password', async () => {
    const res = await request(app)
      .put('/api/auth/update-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'password123', newPassword: 'newpass456' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('message', 'Password updated successfully!');
  });

  it('should fail to update password with incorrect old password', async () => {
    const res = await request(app)
      .put('/api/auth/update-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'wrongpassword', newPassword: 'newpass789' });
    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('error', 'Incorrect old password');
    expect(res.body).toHaveProperty('code', 'AUTH_INVALID_OLD_PASSWORD');
  });

  it('should fail to update password with short new password', async () => {
    const res = await request(app)
      .put('/api/auth/update-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'newpass456', newPassword: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'New password must be at least 6 characters long');
    expect(res.body).toHaveProperty('code', 'AUTH_PASSWORD_TOO_SHORT');
  });
});
