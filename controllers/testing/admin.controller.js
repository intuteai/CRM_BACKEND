// Governance endpoints for the motor-test module (docs/motor-test/admin-api.md).
'use strict';
const logger = require('../../utils/logger');
const m = require('../../models/testing/adminModel');
const { TESTING_ROLES } = require('../../middleware/testingRoles');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RULE_TYPES = ['max', 'min', 'range', 'checkpoint', 'tracking', 'reach', 'bemf_constant'];
const SIGNALS = ['current_a', 'voltage_v', 'rpm_actual', 'bemf_v'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNumOrNull = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

const send = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const invalid = (res, fields) => send(res, 400, 'VALIDATION_ERROR', 'Request failed validation', { fields });

// One place that turns model/database errors into contract errors.
function handle(res, where) {
  return (e) => {
    if (e instanceof m.AdminError) return send(res, e.status, e.code, e.message, e.extra);
    if (e && e.code === '23505') return send(res, 409, 'DUPLICATE', 'That already exists', { detail: e.constraint });
    if (e && e.code === '23503') return send(res, 400, 'UNKNOWN_REFERENCE', 'A referenced record does not exist', { detail: e.constraint });
    if (e && e.code === '23514') return send(res, 400, 'VALIDATION_ERROR', 'A value breaks a data rule', { detail: e.constraint });
    if (e && e.code === '23001') return send(res, 409, 'LIFECYCLE_CONFLICT', String(e.message).replace(/^MT_\w+:\s*/, ''));
    logger.error(`testing admin ${where}: ${e.message}`, { stack: e.stack });
    return send(res, 503, 'SERVER_UNAVAILABLE', 'The server is temporarily unavailable. Please try again.');
  };
}
const uuidParam = (res, v, label) => (UUID.test(v) ? true : (send(res, 404, 'NOT_FOUND', `${label} not found`), false));

// ------------------------------------------------------------------ validation helpers

function variantFields(b, { create }) {
  const f = {}; const err = [];
  if (!isObj(b)) return { err: [{ path: '', msg: 'body must be an object' }] };
  if (create) {
    if (!isInt(b.product_id, 1, 2147483647)) err.push({ path: 'product_id', msg: 'is required (inventory product_id)' }); else f.product_id = b.product_id;
  }
  if ('code' in b || create) {
    if (typeof b.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._\-/]{0,49}$/.test(b.code)) err.push({ path: 'code', msg: '1-50 characters: letters, digits, space . _ - /' });
    else f.code = b.code;
  }
  if ('max_rpm_limit' in b) { if (b.max_rpm_limit !== null && !isInt(b.max_rpm_limit, 1, 100000)) err.push({ path: 'max_rpm_limit', msg: 'null or an integer 1-100000' }); else f.max_rpm_limit = b.max_rpm_limit; }
  for (const k of ['rated_voltage_v', 'rated_power_w', 'rated_current_a']) if (k in b) { if (b[k] !== null && !(typeof b[k] === 'number' && b[k] >= 0 && Number.isFinite(b[k]))) err.push({ path: k, msg: 'null or a number >= 0' }); else f[k] = b[k]; }
  if ('controller_model' in b) { if (b.controller_model !== null && (typeof b.controller_model !== 'string' || b.controller_model.length > 100)) err.push({ path: 'controller_model', msg: 'null or up to 100 characters' }); else f.controller_model = b.controller_model; }
  if ('serial_pattern' in b) {
    if (b.serial_pattern !== null) {
      try { if (typeof b.serial_pattern !== 'string' || b.serial_pattern.length > 200) throw new Error(); new RegExp(b.serial_pattern); f.serial_pattern = b.serial_pattern; } catch { err.push({ path: 'serial_pattern', msg: 'null or a valid regular expression up to 200 characters' }); }
    } else f.serial_pattern = null;
  }
  if (!create && 'active' in b) { if (typeof b.active !== 'boolean') err.push({ path: 'active', msg: 'must be true or false' }); else f.active = b.active; }
  const allowed = new Set(['product_id', 'code', 'max_rpm_limit', 'rated_voltage_v', 'rated_power_w', 'rated_current_a', 'controller_model', 'serial_pattern', 'active']);
  for (const k of Object.keys(b)) if (!allowed.has(k) || (k === 'product_id' && !create)) err.push({ path: k, msg: 'is not an allowed field' });
  return { f, err };
}

function profileFields(b, partial) {
  const f = {}; const err = [];
  if (!isObj(b)) return { err: [{ path: '', msg: 'body must be an object' }] };
  const spec = { max_rpm: [1, 100000], step_rpm: [1, 10000], duration_s: [1, 3600], sample_hz: [5, 1000] };
  for (const [k, [lo, hi]] of Object.entries(spec)) {
    if (!(k in b)) { if (!partial) err.push({ path: k, msg: 'is required' }); continue; }
    if (!isInt(b[k], lo, hi)) err.push({ path: k, msg: `must be an integer ${lo}-${hi}` }); else f[k] = b[k];
  }
  for (const k of Object.keys(b)) if (!(k in spec)) err.push({ path: k, msg: 'is not an allowed field' });
  // A run must fit one upload (40,000 samples max incl. the stop phase).
  if (f.duration_s && f.sample_hz && f.duration_s * f.sample_hz > 36000) err.push({ path: 'sample_hz', msg: 'duration_s x sample_hz must be <= 36000 readings per run' });
  return { f, err };
}

function criteriaFields(b, partial) {
  const f = {}; const err = [];
  if (!isObj(b)) return { err: [{ path: '', msg: 'body must be an object' }] };
  if ('definition' in b || !partial) {
    const d = b.definition;
    if (!isObj(d)) err.push({ path: 'definition', msg: 'is required and must be an object' });
    else {
      if (!Array.isArray(d.rules)) err.push({ path: 'definition.rules', msg: 'must be an array' });
      else {
        const ids = new Set();
        d.rules.forEach((r, i) => {
          const p = `definition.rules[${i}]`;
          if (!isObj(r)) return err.push({ path: p, msg: 'must be an object' });
          if (typeof r.id !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(r.id)) err.push({ path: `${p}.id`, msg: 'UPPER_CASE id, 1-40 characters' });
          else if (ids.has(r.id)) err.push({ path: `${p}.id`, msg: 'duplicate rule id' }); else ids.add(r.id);
          if (!RULE_TYPES.includes(r.type)) err.push({ path: `${p}.type`, msg: `one of ${RULE_TYPES.join(', ')}` });
          if (r.signal !== undefined && r.signal !== null && !SIGNALS.includes(r.signal)) err.push({ path: `${p}.signal`, msg: `one of ${SIGNALS.join(', ')}` });
          for (const k of ['limit', 'min', 'max', 'at_rpm', 'rpm_window', 'exclude_first_ms', 'max_err_rpm', 'exclude_transient_ms', 'target_rpm', 'tolerance_rpm', 'min_rpm']) {
            if (k in r && !isNumOrNull(r[k])) err.push({ path: `${p}.${k}`, msg: 'must be a number or null' });
          }
          if (typeof r.min === 'number' && typeof r.max === 'number' && r.min > r.max) err.push({ path: `${p}.min`, msg: 'must not be above max' });
        });
      }
      if (JSON.stringify(d).length > 100000) err.push({ path: 'definition', msg: 'is too large (max 100 kB)' });
      if (!err.length) { f.definition = { ...d }; delete f.definition.variant_id; delete f.definition.version; } // server sets variant_id/version
    }
  }
  if ('source_document' in b) { if (b.source_document !== null && (typeof b.source_document !== 'string' || b.source_document.length > 300)) err.push({ path: 'source_document', msg: 'null or up to 300 characters' }); else f.source_document = b.source_document; }
  for (const k of Object.keys(b)) if (!['definition', 'source_document'].includes(k)) err.push({ path: k, msg: 'is not an allowed field' });
  return { f, err };
}
const versionFields = (kind, b, partial) => (kind === 'profiles' ? profileFields(b, partial) : criteriaFields(b, partial));

// ------------------------------------------------------------------ products and variants

exports.listProducts = (req, res) => m.listProducts().then((items) => res.json({ items })).catch(handle(res, 'listProducts'));
exports.listVariants = (req, res) => m.listVariants(req.query.include_inactive === '1').then((items) => res.json({ items })).catch(handle(res, 'listVariants'));
exports.getVariant = (req, res) => {
  if (!uuidParam(res, req.params.id, 'Variant')) return;
  m.getVariant(req.params.id).then((v) => (v ? res.json(v) : send(res, 404, 'NOT_FOUND', 'Variant not found'))).catch(handle(res, 'getVariant'));
};
exports.createVariant = (req, res) => {
  const { f, err } = variantFields(req.body, { create: true });
  if (err.length) return invalid(res, err);
  m.createVariant(f, req.user.user_id).then((v) => res.status(201).json(v)).catch(handle(res, 'createVariant'));
};
exports.updateVariant = (req, res) => {
  if (!uuidParam(res, req.params.id, 'Variant')) return;
  const { f, err } = variantFields(req.body, { create: false });
  if (err.length) return invalid(res, err);
  m.updateVariant(req.params.id, f, req.user.user_id).then((v) => res.json(v)).catch(handle(res, 'updateVariant'));
};

// ------------------------------------------------------------------ versions

exports.listVersions = (kind) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Variant')) return;
  m.listVersions(kind, req.params.id).then((items) => res.json({ items })).catch(handle(res, 'listVersions'));
};
exports.getVersion = (kind) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Version')) return;
  m.getVersion(kind, req.params.id).then((v) => (v ? res.json(v) : send(res, 404, 'NOT_FOUND', 'Version not found'))).catch(handle(res, 'getVersion'));
};
exports.createVersion = (kind) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Variant')) return;
  const { f, err } = versionFields(kind, req.body, false);
  if (err.length) return invalid(res, err);
  m.createVersion(kind, req.params.id, f, req.user.user_id).then((v) => res.status(201).json(v)).catch(handle(res, 'createVersion'));
};
exports.updateDraft = (kind) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Version')) return;
  const { f, err } = versionFields(kind, req.body, true);
  if (err.length) return invalid(res, err);
  m.updateDraft(kind, req.params.id, f, req.user.user_id).then((v) => res.json(v)).catch(handle(res, 'updateDraft'));
};
exports.deleteDraft = (kind) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Version')) return;
  m.deleteDraft(kind, req.params.id, req.user.user_id).then(() => res.status(204).end()).catch(handle(res, 'deleteDraft'));
};
exports.transition = (kind, action) => (req, res) => {
  if (!uuidParam(res, req.params.id, 'Version')) return;
  const body = req.body || {};
  if (action === 'withdraw' && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500)) return invalid(res, [{ path: 'reason', msg: 'is required (1-500 characters)' }]);
  if (action === 'return' && body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) return invalid(res, [{ path: 'note', msg: 'up to 500 characters' }]);
  m.transition(kind, req.params.id, action, req.user.user_id, { note: body.note, reason: body.reason && body.reason.trim() })
    .then((v) => res.json(v)).catch(handle(res, `transition ${action}`));
};

// ------------------------------------------------------------------ operators

exports.listOperatorsAdmin = (req, res) => m.listOperatorsAdmin(req.query.include_inactive === '1').then((items) => res.json({ items })).catch(handle(res, 'listOperatorsAdmin'));
function operatorBody(b, create) {
  const f = {}; const err = [];
  if (!isObj(b)) return { err: [{ path: '', msg: 'body must be an object' }] };
  if (create || 'name' in b) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 100) err.push({ path: 'name', msg: '1-100 characters' }); else f.name = b.name; }
  if ('user_id' in b) { if (b.user_id !== null && !isInt(b.user_id, 1, 2147483647)) err.push({ path: 'user_id', msg: 'null or an ERP user id' }); else f.user_id = b.user_id; }
  if (!create && 'active' in b) { if (typeof b.active !== 'boolean') err.push({ path: 'active', msg: 'true or false' }); else f.active = b.active; }
  for (const k of Object.keys(b)) if (!['name', 'user_id', 'active'].includes(k) || (create && k === 'active')) err.push({ path: k, msg: 'is not an allowed field' });
  return { f, err };
}
exports.createOperator = (req, res) => {
  const { f, err } = operatorBody(req.body, true);
  if (err.length) return invalid(res, err);
  m.createOperator(f, req.user.user_id).then((o) => res.status(201).json(o)).catch(handle(res, 'createOperator'));
};
exports.updateOperator = (req, res) => {
  if (!uuidParam(res, req.params.ref, 'Operator')) return;
  const { f, err } = operatorBody(req.body, false);
  if (err.length) return invalid(res, err);
  m.updateOperator(req.params.ref, f, req.user.user_id).then((o) => res.json(o)).catch(handle(res, 'updateOperator'));
};

// ------------------------------------------------------------------ users and roles

exports.listUsers = (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  m.listUsers(q, limit).then((items) => res.json({ items })).catch(handle(res, 'listUsers'));
};
exports.setUserRoles = (req, res) => {
  const id = parseInt(req.params.userId, 10);
  const roles = req.body && req.body.roles;
  if (!isInt(id, 1, 2147483647)) return send(res, 404, 'NOT_FOUND', 'User not found');
  if (!Array.isArray(roles) || roles.some((r) => !TESTING_ROLES.includes(r)) || new Set(roles).size !== roles.length) {
    return invalid(res, [{ path: 'roles', msg: `array of distinct values from ${TESTING_ROLES.join(', ')}` }]);
  }
  m.setUserRoles(id, roles, req.user).then((out) => res.json(out)).catch(handle(res, 'setUserRoles'));
};

// ------------------------------------------------------------------ corrections

exports.listCorrectionsForRun = (req, res) => {
  if (!uuidParam(res, req.params.testId, 'Test run')) return;
  m.listCorrections({ testId: req.params.testId }).then((items) => res.json({ items })).catch(handle(res, 'listCorrectionsForRun'));
};
exports.listCorrectionsAdmin = (req, res) => {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : null;
  m.listCorrections({ status }).then((items) => res.json({ items })).catch(handle(res, 'listCorrectionsAdmin'));
};
exports.addCorrection = (req, res) => {
  if (!uuidParam(res, req.params.testId, 'Test run')) return;
  const b = req.body; const err = [];
  if (!isObj(b)) return invalid(res, [{ path: '', msg: 'body must be an object' }]);
  const cf = b.corrected_fields;
  if (!isObj(cf) || !Object.keys(cf).length) err.push({ path: 'corrected_fields', msg: 'object with at least one of motor_serial, operator_ref, remark' });
  else {
    for (const k of Object.keys(cf)) if (!['motor_serial', 'operator_ref', 'remark'].includes(k)) err.push({ path: `corrected_fields.${k}`, msg: 'cannot be corrected (verdicts and readings never change)' });
    if ('motor_serial' in cf && (typeof cf.motor_serial !== 'string' || !cf.motor_serial.trim() || cf.motor_serial.length > 64 || cf.motor_serial.trim() !== cf.motor_serial)) err.push({ path: 'corrected_fields.motor_serial', msg: '1-64 characters, no leading/trailing spaces' });
    if ('operator_ref' in cf && !(typeof cf.operator_ref === 'string' && UUID.test(cf.operator_ref))) err.push({ path: 'corrected_fields.operator_ref', msg: 'must be an operator_ref (UUID)' });
    if ('remark' in cf && (typeof cf.remark !== 'string' || !cf.remark.trim() || cf.remark.length > 500)) err.push({ path: 'corrected_fields.remark', msg: '1-500 characters' });
  }
  if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500) err.push({ path: 'reason', msg: 'is required (1-500 characters)' });
  if (b.operator_ref !== undefined && b.operator_ref !== null && !(typeof b.operator_ref === 'string' && UUID.test(b.operator_ref))) err.push({ path: 'operator_ref', msg: 'must be an operator_ref (UUID)' });
  for (const k of Object.keys(b)) if (!['corrected_fields', 'reason', 'operator_ref'].includes(k)) err.push({ path: k, msg: 'is not an allowed field' });
  if (err.length) return invalid(res, err);
  m.addCorrection(req.params.testId, { corrected_fields: cf, reason: b.reason, operator_ref: b.operator_ref ?? null }, req.user.user_id)
    .then((c) => res.status(201).json(c)).catch(handle(res, 'addCorrection'));
};
exports.decideCorrection = (req, res) => {
  if (!uuidParam(res, req.params.id, 'Correction')) return;
  const b = req.body || {};
  if (!['APPROVED', 'REJECTED'].includes(b.decision)) return invalid(res, [{ path: 'decision', msg: 'APPROVED or REJECTED' }]);
  if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) return invalid(res, [{ path: 'note', msg: 'up to 500 characters' }]);
  m.decideCorrection(req.params.id, b.decision, b.note ?? null, req.user.user_id).then((c) => res.json(c)).catch(handle(res, 'decideCorrection'));
};

// ------------------------------------------------------------------ audit and export

exports.listAudit = (req, res) => {
  const entity = typeof req.query.entity === 'string' ? req.query.entity.slice(0, 60) : null;
  const entityId = typeof req.query.entity_id === 'string' ? req.query.entity_id.slice(0, 80) : null;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  m.listAudit({ entity, entityId, limit }).then((items) => res.json({ items })).catch(handle(res, 'listAudit'));
};
exports.exportCsv = (req, res) => {
  if (!uuidParam(res, req.params.testId, 'Test run')) return;
  m.exportSamplesCsv(req.params.testId, req.user.user_id).then((csv) => {
    if (csv === null) return send(res, 404, 'NOT_FOUND', 'Test run not found');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="motor-test-${req.params.testId}.csv"`);
    return res.send(csv);
  }).catch(handle(res, 'exportCsv'));
};
