import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoveryCode, normalizeRecoveryCode } from '../src/lib/recoveryCode';

test('recovery codes validate twelve letters/digits in three groups', () => {
  for (const code of ['abcd-1234-ef56', 'ABCD-1234-EF56', '  abcd-1234-ef56  ']) assert.equal(isRecoveryCode(code), true);
  for (const code of [null, undefined, 1234, '', 'abcd1234ef56', 'abc-1234-ef56', 'abcd-1234-ef567', 'abcd-!234-ef56', 'abcd-中文12-ef56', 'abcd-1234\nef56']) assert.equal(isRecoveryCode(code), false);
  assert.equal(normalizeRecoveryCode('  ABCD-1234-EF56  '), 'abcd-1234-ef56');
});
