'use strict';

// Mirrors CRM/src/components/admin/PDIGeneratorForm.jsx's checkTolerance —
// kept as a tiny duplicate rather than a shared package since the frontend
// and backend don't share a build pipeline. Any change here must be mirrored
// there, and vice versa.
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal) || !Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range and flag nearly every row.
  const amount = Math.abs(toleranceAmount);
  const delta = toleranceMode === '%' ? Math.abs(nominal) * (amount / 100) : amount;
  const outOfRange = measured < nominal - delta || measured > nominal + delta;
  return { outOfRange };
}

function parseForwardReverse(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { forward: '', reverse: '' };
  if (trimmed.includes('/')) {
    const [f, r] = trimmed.split('/');
    return { forward: (f || '').trim(), reverse: (r || '').trim() };
  }
  return { forward: trimmed, reverse: '' };
}

module.exports = { checkTolerance, parseForwardReverse };
