// Innopack Parts Roster API (/api/innopack/parts). Innopack-only: the router
// allows role 16 (innopack_design) and nothing else.
const Parts = require('../../models/innopack/parts');
const logger = require('../../utils/logger');
const { validatePart, parseId } = require('./parts.validation');

const EVENT = 'innopack_parts:changed'; // req.io sends it to the Innopack room only

function fail(res, status, code, error, extra) {
  return res.status(status).json({ error, code, ...extra });
}
function invalid(res, fields) {
  return fail(res, 400, 'INVALID_INPUT', 'Some fields are not valid', { fields });
}
function serverError(res, where, err) {
  logger.error(`Innopack parts ${where} failed: ${err && err.message ? err.message : err}`);
  return fail(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.');
}
function notify(req, action, id) {
  try { req.io && req.io.emit(EVENT, { action, id }); } catch (e) { logger.warn(`${EVENT} emit failed: ${e.message}`); }
}

exports.list = async (req, res) => {
  try {
    return res.json({ items: await Parts.list() });
  } catch (err) { return serverError(res, 'list', err); }
};

exports.options = async (req, res) => {
  try {
    return res.json(await Parts.options());
  } catch (err) { return serverError(res, 'options', err); }
};

exports.create = async (req, res) => {
  const { values, errors } = validatePart(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const part = await Parts.create(values, req.user.user_id);
    notify(req, 'created', part.id);
    return res.status(201).json(part);
  } catch (err) { return serverError(res, 'create', err); }
};

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 404, 'NOT_FOUND', 'Part not found');
  const { values, errors } = validatePart(req.body);
  if (errors.length) return invalid(res, errors);
  try {
    const part = await Parts.update(id, values, req.user.user_id);
    if (!part) return fail(res, 404, 'NOT_FOUND', 'Part not found');
    notify(req, 'updated', id);
    return res.json(part);
  } catch (err) { return serverError(res, 'update', err); }
};

exports.remove = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 404, 'NOT_FOUND', 'Part not found');
  try {
    if (!(await Parts.remove(id, req.user.user_id))) return fail(res, 404, 'NOT_FOUND', 'Part not found');
    notify(req, 'deleted', id);
    return res.json({ id });
  } catch (err) { return serverError(res, 'delete', err); }
};
