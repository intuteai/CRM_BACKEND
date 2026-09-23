// checkTolerance had no direct tests before this. Added while touching
// mounting_pcd (backend-changes-v1.0.8.md item 4): the PCD result column
// switched from a measured number to a "GO"/"NG" string, and the PDF
// template still runs it through checkTolerance() via MCOLS's
// isOutOfTolerance. This locks in the one behavior that makes that safe --
// a non-numeric measured value is skipped, not thrown or flagged -- plus the
// three tolerance modes' basic pass/fail behavior.
const { checkTolerance } = require('../models/operations/pdi/tolerance');

describe('checkTolerance', () => {
  it('flags a symmetric (±) reading outside range and passes one inside it', () => {
    expect(checkTolerance('10.6', '10', '±', '0.5').outOfRange).toBe(true);
    expect(checkTolerance('10.4', '10', '±', '0.5').outOfRange).toBe(false);
  });

  it('flags a percentage reading outside range and passes one inside it', () => {
    expect(checkTolerance('3200', '3000', '%', '5').outOfRange).toBe(true); // > 3150
    expect(checkTolerance('3100', '3000', '%', '5').outOfRange).toBe(false);
  });

  it('bilateral wraps min/max so either field can carry the sign (SolidWorks reference case)', () => {
    // nominal 850, "+0.2 / -0.1" -> 849.9 - 850.2
    expect(checkTolerance('850.2', '850', 'bilateral', '0.2', '-0.1').outOfRange).toBe(false);
    expect(checkTolerance('850.3', '850', 'bilateral', '0.2', '-0.1').outOfRange).toBe(true);
    expect(checkTolerance('849.8', '850', 'bilateral', '0.2', '-0.1').outOfRange).toBe(true);
  });

  // The exact mechanism that makes mounting_pcd safe once its measured value
  // is "GO"/"NG" text instead of a number: parseFloat("GO") is NaN, so this
  // returns false rather than throwing or flagging a false positive.
  it('gracefully skips a non-numeric measured value instead of throwing or flagging it', () => {
    expect(() => checkTolerance('GO', '152.7', '±', '0.1')).not.toThrow();
    expect(checkTolerance('GO', '152.7', '±', '0.1').outOfRange).toBe(false);
    expect(checkTolerance('NG', '152.7', '±', '0.1').outOfRange).toBe(false);
  });

  it('gracefully skips when the nominal spec itself is missing/non-numeric', () => {
    expect(checkTolerance('152.7', '', '±', '0.1').outOfRange).toBe(false);
    expect(checkTolerance('152.7', undefined, '±', '0.1').outOfRange).toBe(false);
  });

  it('a legacy report\'s numeric mounting_pcd is still checked normally', () => {
    // Old reports keep a real measured number here (per the MD's own
    // fallback note) -- this must keep flagging out-of-tolerance the same
    // way it always has.
    expect(checkTolerance('153.5', '152.7', '±', '0.2').outOfRange).toBe(true);
    expect(checkTolerance('152.8', '152.7', '±', '0.2').outOfRange).toBe(false);
  });
});
