'use strict';

// Mirrors CRM/src/components/admin/PDIGeneratorForm.jsx's checkTolerance —
// kept as a tiny duplicate rather than a shared package since the frontend
// and backend don't share a build pipeline. Any change here must be mirrored
// there, and vice versa. A third, independent implementation also lives in
// pdi-erp-app/src/services/tolerance.ts (TypeScript, different shape) — the
// FORMULA below must stay identical across all three, since the same report
// can be edited from any of the three apps and must get the same pass/fail
// result everywhere.
//
// Three modes:
//   '±'  (Symmetric):  range = [nominal - tol,  nominal + tol]
//   '%'  (Percentage): range = [nominal - nominal*tol/100, nominal + nominal*tol/100]
//   'bilateral':        range = [nominal + min(tol, tol2), nominal + max(tol, tol2)]
// Bilateral's min/max wrapping is deliberate — same defensive reasoning as
// the existing Math.abs guard below, so a mistyped sign on either field
// can't silently invert the range.
function checkTolerance(measuredStr, nominalStr, toleranceMode, toleranceAmountStr, toleranceAmount2Str) {
  const measured = parseFloat(measuredStr);
  const nominal = parseFloat(nominalStr);
  if (!Number.isFinite(measured) || !Number.isFinite(nominal)) {
    return { outOfRange: false };
  }

  // Note: any toleranceMode value that isn't exactly the literal string
  // 'bilateral' falls through to the symmetric/percentage branch below,
  // which reads only toleranceAmountStr and silently ignores
  // toleranceAmount2Str. This is intentional -- consistent with this
  // function's existing philosophy of gracefully skipping validation on
  // malformed input rather than throwing -- not an oversight. The mode
  // string is driven by a fixed <select> in both UI clients, not free
  // text, so a real-world typo reaching this function is unlikely, but
  // this comment exists so a future reader doesn't mistake the fallthrough
  // for a bug.
  if (toleranceMode === 'bilateral') {
    const plus = parseFloat(toleranceAmountStr);
    const minus = parseFloat(toleranceAmount2Str);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) {
      return { outOfRange: false };
    }
    const low = nominal + Math.min(plus, minus);
    const high = nominal + Math.max(plus, minus);
    return { outOfRange: measured < low || measured > high };
  }

  const toleranceAmount = parseFloat(toleranceAmountStr);
  if (!Number.isFinite(toleranceAmount)) {
    return { outOfRange: false };
  }
  // Math.abs on the tolerance amount itself — a negative value typed by
  // mistake would otherwise invert the range (nominal - delta > nominal +
  // delta) and flag nearly every row at once.
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

// Parses a Shaft Diameter/Length cell's raw text into { diameter, length }.
// "12/45" -> diameter=12, length=45. Same split-on-"/" mechanics as
// parseForwardReverse above, distinctly named since "forward/reverse"
// semantics don't apply here — diameter and length are validated against
// two entirely independent specs, not a shared one.
function parseDiaLength(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { diameter: '', length: '' };
  if (trimmed.includes('/')) {
    const [d, l] = trimmed.split('/');
    return { diameter: (d || '').trim(), length: (l || '').trim() };
  }
  return { diameter: trimmed, length: '' };
}

module.exports = { checkTolerance, parseForwardReverse, parseDiaLength };
