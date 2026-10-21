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
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/theme.ts', 'src/components/ds/**'],
    plugins: { 'design-tokens': require('./scripts/eslint/design-tokens.cjs') },
    rules: {
      'design-tokens/no-raw-colors': 'error',
      'design-tokens/no-magic-spacing': 'error',
    },
  },
]);
