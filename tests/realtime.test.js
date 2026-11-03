// Live updates (Socket.IO) must stay inside one organization: a socket needs
// a valid login, joins only its own organization's room, and an update made
// by a Compage user never reaches an Intute AI browser (or the reverse).
// Database and JWT are mocked.
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
const jwt = require('jsonwebtoken');

const { roomsFor, roomsForSocketUser, scopedIo, socketAuth } = require('../config/realtime');

function fakeIo() {
  const sent = [];
  return {
    sent,
    to: jest.fn((rooms) => ({ emit: (event, payload) => sent.push({ rooms, event, payload }) })),
    emit: jest.fn(),
  };
}

describe('roomsFor (where an update made by this user goes)', () => {
  it('Intute AI users only reach the Intute AI room', () => {
    expect(roomsFor({ role_id: 11 }, 'ia_orders:created')).toEqual(['org:ia']);
    expect(roomsFor({ role_id: 12 }, 'activities:updated')).toEqual(['org:ia']);
  });

  it('Compage business updates reach Compage staff only', () => {
    expect(roomsFor({ role_id: 1 }, 'bom:created')).toEqual(['org:compage']);
    expect(roomsFor({ role_id: 8 }, 'invoiceUpdate')).toEqual(['org:compage']);
  });

  it('stock updates also reach customers, who order from that list', () => {
    expect(roomsFor({ role_id: 6 }, 'stockUpdate')).toEqual(['org:compage', 'customers']);
  });

  it('Compage activity and attendance updates reach Compage employee/HR only', () => {
    expect(roomsFor({ role_id: 10 }, 'activities:created')).toEqual(['people:compage']);
    expect(roomsFor({ role_id: 9 }, 'attendanceMarked')).toEqual(['people:compage']);
  });

  it('no user or unknown role: the update goes nowhere', () => {
    expect(roomsFor(undefined, 'bom:created')).toEqual([]);
    expect(roomsFor({ role_id: 99 }, 'bom:created')).toEqual([]);
  });
});

describe('roomsForSocketUser (which rooms a connected browser joins)', () => {
  it('Intute AI user joins only Intute AI and personal rooms', () => {
    expect(roomsForSocketUser({ user_id: 5, role_id: 12 }).sort()).toEqual(['org:ia', 'user:5', 'user_5'].sort());
  });
  it('Compage HR joins Compage staff and people rooms', () => {
    expect(roomsForSocketUser({ user_id: 6, role_id: 10 }).sort()).toEqual(['org:compage', 'people:compage', 'user:6', 'user_6'].sort());
  });
  it('a customer joins only the customer room and their own', () => {
    expect(roomsForSocketUser({ user_id: 7, role_id: 2 }).sort()).toEqual(['customers', 'user:7', 'user_7'].sort());
  });
  it('unknown role joins only its personal rooms', () => {
    expect(roomsForSocketUser({ user_id: 8, role_id: 99 }).sort()).toEqual(['user:8', 'user_8'].sort());
  });
});

describe('scopedIo (the req.io each request gets)', () => {
  it('emit goes to the acting user\'s organization, never to everyone', () => {
    const io = fakeIo();
    const req = { user: { user_id: 1, role_id: 11 } };
    scopedIo(io, req).emit('ia_orders:created', { id: 1 });
    expect(io.emit).not.toHaveBeenCalled();
    expect(io.sent).toEqual([{ rooms: ['org:ia'], event: 'ia_orders:created', payload: { id: 1 } }]);
  });

  it('user is read from this request and cannot be overwritten by another', () => {
    const io = fakeIo();
    const reqA = { user: { user_id: 1, role_id: 11 } };
    const reqB = { user: { user_id: 2, role_id: 1 } };
    const a = scopedIo(io, reqA);
    const b = scopedIo(io, reqB);
    b.user = reqA.user; // legacy code assigned io.user; must have no effect
    expect(a.user.user_id).toBe(1);
    expect(b.user.user_id).toBe(2);
  });

  it('emit before login (no req.user) sends nothing', () => {
    const io = fakeIo();
    scopedIo(io, {}).emit('bom:created', {});
    expect(io.sent).toEqual([]);
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('to(room) still works for targeted messages', () => {
    const io = fakeIo();
    scopedIo(io, { user: { user_id: 3, role_id: 2 } }).to('user:3').emit('queryUpdate', { q: 1 });
    expect(io.sent).toEqual([{ rooms: 'user:3', event: 'queryUpdate', payload: { q: 1 } }]);
  });
});

describe('socketAuth (connection handshake)', () => {
  beforeEach(() => { mockQuery.mockReset(); jwt.verify.mockReset(); });
  const socketWith = (handshake) => ({ handshake: { auth: {}, headers: {}, ...handshake }, data: {} });

  it('rejects a connection with no token', async () => {
    const next = jest.fn();
    await socketAuth(socketWith({}), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects an invalid token', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('bad'); });
    const next = jest.fn();
    await socketAuth(socketWith({ auth: { token: 'x' } }), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects a token for a user that no longer exists', async () => {
    jwt.verify.mockReturnValue({ user_id: 9 });
    mockQuery.mockResolvedValue({ rows: [] });
    const next = jest.fn();
    await socketAuth(socketWith({ auth: { token: 'x' } }), next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('accepts a valid token and records the user from the database, not the token', async () => {
    jwt.verify.mockReturnValue({ user_id: 9, role_id: 1 });
    mockQuery.mockResolvedValue({ rows: [{ user_id: 9, role_id: 12 }] });
    const socket = socketWith({ auth: { token: 'x' } });
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toEqual({ user_id: 9, role_id: 12 });
  });

  it('also accepts the token from an Authorization header', async () => {
    jwt.verify.mockReturnValue({ user_id: 4 });
    mockQuery.mockResolvedValue({ rows: [{ user_id: 4, role_id: 3 }] });
    const socket = socketWith({ headers: { authorization: 'Bearer abc' } });
    const next = jest.fn();
    await socketAuth(socket, next);
    expect(jwt.verify).toHaveBeenCalledWith('abc', process.env.JWT_SECRET);
    expect(next).toHaveBeenCalledWith();
  });
});
