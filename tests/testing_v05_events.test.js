// The production v0.5 event validator must give exactly the reference results for every published vector.
//   npx jest tests/testing_v05_events.test.js
const path = require('path');
const prod = require('../services/testing/v05Events');
const vectors = require(path.join(__dirname, '..', 'docs', 'motor-test', 'contract', 'vectors', 'v05-event-vectors.json'));

describe('v0.5 events: production validator = reference vectors', () => {
  it.each(vectors.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const got = prod.validate(c.v05_fields, c.run_context);
    if (c.expected.result === 'accepted') {
      expect(got.ok).toBe(true);
      expect(got.flags).toEqual(c.expected.flags);
      expect(got.digest).toBe(c.expected.recomputed_event_digest);
    } else {
      expect(got.ok).toBe(false);
      expect({ status: got.status, rule: got.rule }).toEqual({ status: c.expected.status, rule: c.expected.rule });
    }
  });
});
