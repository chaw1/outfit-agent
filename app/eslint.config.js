const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expo,
  { ignores: ['dist/**', '.expo/**', '.tools/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  {
    rules: {
      'import/order': 'warn',
      'react-hooks/exhaustive-deps': 'error',
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
]);
