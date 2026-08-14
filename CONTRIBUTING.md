# Contributing to VoxelLab

Thanks for taking the time to improve VoxelLab. Focused bug fixes, tests, and
compatibility improvements are the easiest changes to review. Please open an
issue before starting a large feature or architecture change.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems through the private process in [SECURITY.md](SECURITY.md),
not through a public issue.

## Development Setup

Requirements:

- Node.js 22.12.0, as recorded in `.node-version`
- Python 3.11 or newer

```bash
git clone https://github.com/kaanarici/VoxelLab.git
cd VoxelLab
npm run setup
npm start
```

Open <http://localhost:8000>. The browser viewer uses static HTML, CSS, and
JavaScript modules. It has no frontend bundle step.

To run the desktop shell:

```bash
npm run desktop:start
```

Optional processing dependencies are installed only when needed:

```bash
npm run setup -- --pipeline
npm run setup -- --pipeline --cloud
npm run setup -- --pipeline --rtk
```

## Before You Change Code

- Check the support boundary in [README.md](README.md).
- Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing import, geometry,
  rendering, state, or processing paths.
- Do not commit real patient data, credentials, local paths, private service
  URLs, `.env` files, or generated research outputs.
- Reduce every reproduction file and screenshot to deidentified test data.

## Code Map

| Path | Purpose |
|---|---|
| `index.html`, `templates/`, `css/` | Viewer markup and presentation |
| `viewer.js` | Browser composition root |
| `js/core/` | State, geometry, coordinates, and shared runtime rules |
| `js/dicom/` | DICOM, NIfTI, DICOMweb, and derived-object import |
| `js/mpr/`, `js/volume/` | MPR and 3D rendering |
| `js/projects/`, `js/series/` | Study intake and active-series workflows |
| `js/roi/`, `js/overlay/` | Measurements, annotations, and overlays |
| `electron/` | Desktop shell and local file bridge |
| `python/` | Local server and optional processing paths |
| `scripts/` | Setup, validation, demo, and release helpers |
| `tests/` | Node, Python, browser, and Electron tests |
| `demo_packs/` | Public demo catalog and lite demo archive |

## Project Rules

- Reuse the shared geometry contract in `js/core/geometry.js` and
  `python/geometry.py`. Do not add a parallel slice-ordering, spacing, or affine
  implementation.
- Update `tests/fixtures/geometry/canonical-cases.json` when the shared geometry
  contract changes, then run `npm run check:geometry`.
- Keep unsupported inputs honest. Mark them 2D-only or reject them until the
  required geometry, calibration, and decoder behavior are proven.
- Use dependency injection from `viewer.js` rather than circular module imports.
- Use `const` by default and `let` only when mutation is required.
- Escape dynamic content before it reaches `innerHTML`.
- Keep public `config.json` values generic and safe. Runtime account values
  belong in `.env` or deployment settings.
- Comments should explain a non-obvious invariant or imaging constraint, not
  narrate the implementation.

## Tests

Run the strongest relevant checks for your change. The default local and CI
gate is:

```bash
npm run check
```

Focused commands include:

```bash
npm run lint:ci
npm run check:geometry
npm run check:accuracy
npm run test:node
npm run test:python
npm run test:browser
```

Changes to a visible workflow should include browser or Electron coverage and
should be exercised in the running app. Changes to import, measurements, or
calibration need fixtures that prove both the supported case and the honest
failure case.

`npm run check` does not call cloud providers, upload to R2, or run long GPU
jobs. Use `npm run check:cloud` for the optional cloud configuration preflight.

## Pull Requests

Keep each pull request centered on one outcome. In the description, include:

- the problem and the user-visible result
- the affected formats or workflows
- the checks you ran and their results
- screenshots for visible UI changes
- any limits that remain untested

Update the README, architecture notes, accuracy ledger, or changelog when a
public claim changes. Do not broaden a support claim beyond the evidence in the
tests.
