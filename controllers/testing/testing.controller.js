// Motor-test API (HMI <-> ERP). Contract: docs/motor-test/contract/openapi.yaml.
// Errors are always {error, code, ...details}.
'use strict';
const jwt = require('jsonwebtoken');
const logger = require('../../utils/logger');
const model = require('../../models/testing/testingModel');
const { loadTestingRoles } = require('../../middleware/testingRoles');
const { payloadHash } = require('../../services/testing/digest');
const { checkSchema, checkConsistency } = require('../../services/testing/validateRun');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const fail = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const unavailable = (res, e, where) => {
  logger.error(`testing ${where}: ${e.message}`, { stack: e.stack });
  return fail(res, 503, 'SERVER_UNAVAILABLE', 'The server is temporarily unavailable. Please try again.');
};

exports.me = async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    const exp = jwt.decode(token)?.exp;
    const roles = req.testingRoles || await loadTestingRoles(req.user.user_id, req.user.role_id);
    res.json({ user_id: req.user.user_id, name: req.user.name, testing_roles: roles, token_expires_at: exp ? new Date(exp * 1000).toISOString() : null });
  } catch (e) { unavailable(res, e, 'me'); }
};

exports.listOperators = async (req, res) => {
  try { res.json({ items: await model.listOperators() }); } catch (e) { unavailable(res, e, 'operators'); }
};

exports.listVariants = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 20));
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  try { res.json(await model.listVariants({ q, page, pageSize })); } catch (e) { unavailable(res, e, 'variants'); }
};

exports.getVariant = async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'NOT_FOUND', 'Variant not found');
  try {
    const v = await model.getVariantDetail(req.params.id);
    if (!v) return fail(res, 404, 'NOT_FOUND', 'Variant not found');
    if (!v.profile || !v.criteria) return fail(res, 409, 'NOT_PUBLISHED', 'This variant has no published profile and criteria yet');
    res.json(v);
  } catch (e) { unavailable(res, e, 'variant'); }
};

exports.getCriteria = async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'NOT_FOUND', 'Criteria version not found');
  try {
    const c = await model.getCriteriaSnapshot(req.params.id);
    if (!c) return fail(res, 404, 'NOT_FOUND', 'Criteria version not found');
    res.json(c);
  } catch (e) { unavailable(res, e, 'criteria'); }
};

exports.postResult = async (req, res) => {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is larger than 5 MB');
  const b = req.body;
  const schemaErrors = checkSchema(b);
  const key = req.get('Idempotency-Key');
  if (!key) schemaErrors.unshift({ path: 'header:Idempotency-Key', msg: 'is required and must equal body.test_id' });
  else if (b && key !== b.test_id) schemaErrors.unshift({ path: 'header:Idempotency-Key', msg: 'must equal body.test_id' });
  if (schemaErrors.length) return fail(res, 400, 'VALIDATION_ERROR', 'Request body failed validation', { fields: schemaErrors });

  const consistency = checkConsistency(b);
  if (consistency.badRequest) return fail(res, 400, 'VALIDATION_ERROR', 'Request body failed validation', { fields: consistency.badRequest });
  let hash;
  try { hash = payloadHash(b); } catch (e) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Request body cannot be canonicalised', { fields: [{ path: '', msg: e.message }] });
  }

  try {
    const out = await model.storeRun({
      body: b, payloadHash: hash, samplesDigest: consistency.samplesDigest,
      violations: consistency.violations, uploadedBy: req.user.user_id,
    });
    if (out.status === 201) logger.info(`motor test stored ${b.test_id} serial ${b.motor_serial} ${b.final_state}/${b.outcome} samples ${b.samples.length} by user ${req.user.user_id}`);
    if (out.status === 409) logger.warn(`motor test upload conflict ${b.test_id} by user ${req.user.user_id}`);
    return res.status(out.status).json(out.body);
  } catch (e) {
    return unavailable(res, e, 'postResult'); // nothing was committed; the HMI retries the same body
  }
};

exports.listResults = async (req, res) => {
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  if (!serial || serial.length > 64) return fail(res, 400, 'VALIDATION_ERROR', 'serial is required (1-64 characters)', { fields: [{ path: 'query:serial', msg: 'is required' }] });
  try { res.json({ motor_serial: serial, runs: await model.listRunsBySerial(serial) }); } catch (e) { unavailable(res, e, 'listResults'); }
};

exports.getResult = async (req, res) => {
  if (!UUID.test(req.params.testId)) return fail(res, 404, 'NOT_FOUND', 'Test run not found');
  const offset = Math.min(4294967295, Math.max(0, parseInt(req.query.samples_offset, 10) || 0));
  const limit = Math.min(5000, Math.max(1, parseInt(req.query.samples_limit, 10) || 2000));
  try {
    const run = await model.getRun(req.params.testId, { offset, limit });
    if (!run) return fail(res, 404, 'NOT_FOUND', 'Test run not found');
    res.json(run);
  } catch (e) { unavailable(res, e, 'getResult'); }
};

// Body-parser errors on /api/testing in the contract format (mounted before the global error handler).
exports.errorHandler = (err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON', { fields: [{ path: '', msg: 'invalid JSON' }] });
  return next(err);
};
