// Live updates (Socket.IO), kept inside one organization.
//
// Every socket must log in (the same JWT the API uses). On connect it joins:
//   user:<id> and user_<id>  personal rooms (both spellings are used)
//   org:ia                   Intute AI roles
//   org:compage              Compage staff (every Compage role but customer)
//   people:compage           Compage employee + HR (activities, attendance)
//   customers                customers
//
// Code emits through req.io, which is scopedIo(): emit() goes only to the
// acting user's organization, never to every connected browser.

const jwt = require('jsonwebtoken');
const pool = require('./db');
const logger = require('../utils/logger');
const { ROLES, orgOf } = require('../middleware/roles');

const COMPAGE_PEOPLE_ROLES = new Set([ROLES.EMPLOYEE, ROLES.HR]);
// Activity and attendance updates belong to the HR side only.
const PEOPLE_EVENT = /^(activities:|attendanceMarked$)/;
// Customers order from the stock list, so they get its updates too.
const CUSTOMER_EVENTS = new Set(['stockUpdate']);

// Rooms an update made by `user` is sent to.
function roomsFor(user, event) {
  const org = orgOf(user?.role_id);
  if (org === 'ia') return ['org:ia'];
  if (org !== 'compage') return [];
  if (PEOPLE_EVENT.test(event)) return ['people:compage'];
  return CUSTOMER_EVENTS.has(event) ? ['org:compage', 'customers'] : ['org:compage'];
}

// Rooms a connected socket for `user` joins.
function roomsForSocketUser(user) {
  const rooms = [`user:${user.user_id}`, `user_${user.user_id}`];
  const roleId = Number(user.role_id);
  const org = orgOf(roleId);
  if (org === 'ia') rooms.push('org:ia');
  else if (roleId === ROLES.CUSTOMER) rooms.push('customers');
  else if (org === 'compage') {
    rooms.push('org:compage');
    if (COMPAGE_PEOPLE_ROLES.has(roleId)) rooms.push('people:compage');
  }
  return rooms;
}

// The req.io a request sees. `user` always reads this request's own user
// (models use io.user for created_by), and assigning it is ignored, so one
// request can never overwrite another's user.
function scopedIo(io, req) {
  return {
    get user() { return req.user; },
    set user(_ignored) {},
    emit(event, ...args) {
      const rooms = roomsFor(req.user, event);
      if (rooms.length) io.to(rooms).emit(event, ...args);
      return true;
    },
    to(room) { return io.to(room); },
    in(room) { return io.in(room); },
  };
}

function tokenFrom(handshake) {
  if (handshake?.auth?.token) return String(handshake.auth.token);
  const header = handshake?.headers?.authorization || '';
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}

// io.use() middleware: refuse sockets without a valid login.
async function socketAuth(socket, next) {
  try {
    const token = tokenFrom(socket.handshake);
    if (!token) return next(new Error('unauthorized'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.user_id) return next(new Error('unauthorized'));
    const { rows } = await pool.query('SELECT user_id, role_id FROM users WHERE user_id = $1', [payload.user_id]);
    if (rows.length === 0) return next(new Error('unauthorized'));
    socket.data.user = { user_id: Number(rows[0].user_id), role_id: Number(rows[0].role_id) };
    return next();
  } catch (err) {
    logger.warn(`Socket auth refused: ${err && err.message ? err.message : err}`);
    return next(new Error('unauthorized'));
  }
}

function attachRealtime(io) {
  io.use(socketAuth);
  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(roomsForSocketUser(user));
    logger.info(`Socket.IO client connected: ${socket.id} (user ${user.user_id})`);
    socket.on('disconnect', () => logger.info(`Socket.IO client disconnected: ${socket.id}`));
  });
}

module.exports = { roomsFor, roomsForSocketUser, scopedIo, socketAuth, attachRealtime };
