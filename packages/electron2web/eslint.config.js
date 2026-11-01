'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['bin/**/*.js', '**/*.cjs', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // Runs in the browser: the runtime is bundled by esbuild, the shell is served as is,
    // and loader.cjs holds a function that is stringified into a page.
    files: ['src/client/**/*.js', 'src/loader.cjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/client/runtime.js'],
    languageOptions: { sourceType: 'module' },
  },
  {
    files: ['src/client/shell.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      eqeqeq: ['error', 'smart'],
      'no-shadow': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
