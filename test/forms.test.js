const { test } = require('node:test');
const assert = require('node:assert');
const { parseActive } = require('../src/utils/forms');

test('parseActive: only "0" is inactive; everything else is active', () => {
  assert.strictEqual(parseActive('0'), 0);
  assert.strictEqual(parseActive('1'), 1);
  assert.strictEqual(parseActive(undefined), 1); // create default
  assert.strictEqual(parseActive('on'), 1);
});
