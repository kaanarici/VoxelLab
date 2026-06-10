// ESLint 9 flat config — dev-only; the app itself has no build step.
// Run: npm run lint
import js from '@eslint/js';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    ignores: [
      'data/**',
      'node_modules/**',
      'middleware.js',
      '.vercel/**',
      'dist/**',
      'build/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'viewer.js'],
    ignores: ['js/volume/volume-worker.js'],
    plugins: {
      unicorn,
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      // Keep noise low; tighten incrementally (see contributor notes in README).
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Intentional silent catches for localStorage / plugin hooks
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Filenames must be kebab-case everywhere (enforced repo-wide).
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    },
  },
  {
    // Architecture invariants for the new @-aliased layers (js/core, js/ui, …).
    // Ordered imports and acyclic boundaries are enforced as modules migrate
    // into these folders across later phases; the legacy flat js/ tree still
    // carries pre-existing cycles tracked separately.
    files: [
      'js/core/**/*.js',
      'js/ui/**/*.js',
      'js/microscopy/**/*.js',
      'js/dicom/**/*.js',
      'js/volume/**/*.js',
      'js/mpr/**/*.js',
      'js/roi/**/*.js',
      'js/overlay/**/*.js',
      'js/series/**/*.js',
      'js/projects/**/*.js',
      'js/shell/**/*.js',
    ],
    // The worker is a separate module realm linted by its own block below.
    ignores: ['js/volume/volume-worker.js'],
    rules: {
      'import/order': ['error', { 'newlines-between': 'ignore' }],
      // Lazy `await import()` is the codebase's deliberate cycle boundary;
      // a cycle that routes through one is allowed (broken at runtime).
      'import/no-cycle': ['error', { allowUnsafeDynamicCyclicDependency: true }],
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
      // importScripts + UMD eval pattern for fzstd in worker
      'no-eval': 'off',
    },
  },
];
