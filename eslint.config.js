import js from '@eslint/js';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      'data/**',
      'node_modules/**',
      'dist/**',
      'build/**',
    ],
  },
  js.configs.recommended,
  {
    plugins: {
      local: {
        rules: {
          'no-comments': {
            create(context) {
              return {
                Program() {
                  for (const comment of context.sourceCode.getAllComments()) {
                    if (comment.type !== 'Shebang') context.report({ loc: comment.loc, message: 'Express intent in code, tests, or documentation.' });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: { 'local/no-comments': 'error' },
  },
  {
    files: ['js/**/*.js', 'viewer.js'],
    ignores: ['js/volume/volume-worker.js'],
    plugins: {
      unicorn,
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {

      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      'no-empty': ['error', { allowEmptyCatch: true }],

      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    },
  },
  {
    files: ['js/**/*.js', 'viewer.js'],
    ignores: [
      'js/core/state/**',
      'js/runtime/**',
      'js/volume/volume-worker.js',
    ],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "AssignmentExpression[left.object.name='state']",
        message: 'Assign viewer state through commands or runtime setters.',
      }, {
        selector: "AssignmentExpression[left.object.object.name='state']",
        message: 'Assign viewer state through commands or runtime setters.',
      }, {
        selector: "UnaryExpression[operator='delete'][argument.object.name='state']",
        message: 'Delete viewer state through commands or runtime setters.',
      }, {
        selector: "UnaryExpression[operator='delete'][argument.object.object.name='state']",
        message: 'Delete viewer state through commands or runtime setters.',
      }],
    },
  },
  {

    files: [
      'js/core/**/*.js',
      'js/microscopy/**/*.js',
      'js/dicom/**/*.js',
      'js/volume/**/*.js',
      'js/mpr/**/*.js',
      'js/roi/**/*.js',
      'js/overlay/**/*.js',
      'js/series/**/*.js',
      'js/projects/**/*.js',
      'js/intake/**/*.js',
      'js/shell/**/*.js',
    ],

    ignores: ['js/volume/volume-worker.js'],
    rules: {
      'import/order': ['error', { 'newlines-between': 'ignore' }],

      'import/no-cycle': ['error', { allowUnsafeDynamicCyclicDependency: true }],
    },
  },
  {
    files: ['js/core/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/config.js',
            '**/dom.js',
            '**/notify.js',
            '**/shell/**',
            '**/series/**',
            '**/mpr/**',
            '**/volume/**',
            '**/overlay/**',
            '**/runtime/**',
          ],
          message: 'js/core cannot import config, dom, notify, shell, series, mpr, volume, overlay, or runtime.',
        }],
      }],
    },
  },
  {
    files: ['electron/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        Response: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.node,
        AbortController: 'readonly',
        ReadableStream: 'readonly',
        Response: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', vars: 'local', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-redeclare': 'off',
    },
  },
  {
    files: ['js/volume/volume-worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.worker,
        ...globals.es2021,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],

      'no-eval': 'off',
    },
  },
];
