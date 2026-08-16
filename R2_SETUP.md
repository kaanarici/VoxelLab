# Optional Cloud Processing Setup

VoxelLab does not need a cloud service to open local files. This guide is for
operators who want to run the optional Modal processing path with Cloudflare R2
object storage.

Cloud processing uploads selected source files to infrastructure you control.
Confirm that your data policy permits this before enabling it. VoxelLab is not
for clinical use.

## Requirements

- Node.js 22.12.0
- Python 3.13 for local tooling (setup accepts 3.11+; the Modal image uses 3.11)
- A Cloudflare account with R2 enabled
- A Modal account

Install the cloud dependencies:

```bash
npm run setup -- --pipeline --cloud
```

## Create the R2 Bucket

1. Create a private input bucket and a separate derived-results bucket.
2. Keep every public URL and custom domain disabled on the input bucket.
3. Create S3-compatible credentials with read and write access to both buckets.
4. Configure a custom domain for public reads on the results bucket only. An
   `r2.dev` subdomain is suitable only for development because Cloudflare
   rate-limits it.
5. Add the upload CORS rules below to the private input bucket.
6. On the input bucket, add an Object Lifecycle Rule for the `uploads/` prefix
   that expires objects after one day. R2 applies lifecycle deletion
   asynchronously, typically within 24 hours of the expiration time.

Example CORS policy:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:8000", "http://localhost:8000", "https://viewer.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use the narrowest origins and credentials that fit your deployment. The local
server binds `127.0.0.1`. `http://localhost:8000` is a different CORS origin —
include both if you open the viewer that way. The desktop app origin is
`voxellab://app`; add it if you process from Electron.

## Configure Local Secrets

Create a local `.env` file and set these values:

```bash
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_UPLOAD_BUCKET=voxellab-inputs
R2_RESULTS_BUCKET=scan-data
R2_PUBLIC_URL=https://<public-r2-host>

MODAL_WEBHOOK_BASE=https://<modal-deployment-base>
MODAL_AUTH_TOKEN=<long-random-token>
TRUSTED_UPLOAD_ORIGINS=https://<account-id>.r2.cloudflarestorage.com
VIEWER_CLOUD_PROCESSING=true
```

`VIEWER_CLOUD_PROCESSING=true` is required for the in-app **Process CT/MR on
cloud GPU** action. Filling Modal and R2 URLs is not enough: committed
`config.json` keeps cloud processing off. You can also enable it later in
**Cloud settings** (Upload study → Advanced, or the desktop menu).

`TRUSTED_UPLOAD_ORIGINS` means the exact HTTPS origins allowed in returned
presigned PUT URLs, not browser origins. Use the R2 S3 API host
(`https://<account-id>.r2.cloudflarestorage.com`), never an `r2.dev` or
custom-domain public URL. The local server derives that S3 origin from
`R2_ENDPOINT` automatically. Desktop/static deployments must set it
explicitly. Presigned URLs cannot use an R2 public custom domain.

The bucket CORS `AllowedOrigins` list has the separate meaning shown above: it
contains browser viewer origins such as `http://127.0.0.1:8000`.

Do not commit `.env`. Use R2 S3 client credentials, not a Cloudflare account
token.

Optional `MRI_VIEWER_MODAL_*` variables control GPU type, memory, temporary
disk, concurrency, retries, and transfer workers. Start with the application
defaults and adjust them only after measuring your workload and account limits.
`MRI_VIEWER_MODAL_GPU` accepts Modal's current GPU names or a comma-separated
fallback list such as `L4,A10,T4`; the legacy `A10G` spelling is normalized to
Modal's current `A10` name. Unknown GPU names stop deployment instead of
silently changing the requested hardware.
Leave `MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB` at `0` to use Modal's current
512 GiB default. Explicit requests must be between 524288 and 3145728 MiB;
other values stop deployment.

## Configure Modal

Log in once:

```bash
. .venv/bin/activate
modal login
```

Create a Modal secret named by `MRI_VIEWER_MODAL_R2_SECRET`. The default name is
`r2-creds`. It must provide `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_UPLOAD_BUCKET`,
`R2_RESULTS_BUCKET`, `R2_PUBLIC_URL`, and `MODAL_AUTH_TOKEN` to
`python/modal_app.py`.

Export `.env` into the current shell before deploy. `python/modal_app.py` reads
process environment at import time and does not load `.env` itself:

```bash
set -a
. ./.env
set +a
modal deploy python/modal_app.py
```

The deployment explicitly packages its local Python modules, as required by
Modal 1.x. Its Python image dependencies are fully resolved in
`requirements/modal-pipeline.lock` and `requirements/modal-web.lock`; Modal
installs them with hash verification. Regenerate those reviewed locks from the
matching `.in` files with `uv pip compile --generate-hashes` when intentionally
upgrading dependencies. After deployment, run the read-only runtime check to
verify that CUDA, the processing executables, both configured R2 buckets, and the
deployed secret are available:

```bash
PYTHONPATH=python .venv/bin/python - <<'PY'
import modal

check = modal.Function.from_name("medical-imaging-pipeline", "verify_runtime")
print(check.remote())
PY
```

The check starts one bounded GPU container and performs `HeadBucket` against
both buckets; it does not upload, modify, or process study data. It also
confirms CUDA and `TotalSegmentator` on the Modal image. A local
`npm run setup -- --pipeline` install does not include TotalSegmentator.

Record the deployed endpoint base as `MODAL_WEBHOOK_BASE`, then run the local
configuration preflight:

```bash
npm run check:cloud
```

The preflight checks configuration and local executables. It does not upload
files or start a cloud job.

When migrating an existing single-bucket deployment, first create the private
input bucket and set both split bucket variables. Confirm the former shared
bucket contains no raw `uploads/` objects before retaining it as the public
results bucket, and disable every public domain and `r2.dev` URL on the input
bucket. Do not deploy the split configuration until both bucket checks pass.

For a read-only credential and connectivity check of both R2 buckets, omit
`--dry-run`:

```bash
node scripts/run_python.mjs scripts/check_env.py --mode cloud --r2-only
```

## Submit a Study

```bash
npm run modal:submit -- /path/to/dicoms --job-id my-job-001 --modality auto
node scripts/run_python.mjs scripts/merge_modal_result.py \
  --r2-public-url "$R2_PUBLIC_URL" \
  --job-id my-job-001
```

The submitter requests short-lived presigned URLs, uploads the selected files,
starts processing, polls the job, and reads the manifest-compatible result.
Calibrated projection and ultrasound reconstruction also require a valid
`voxellab.source.json` sidecar and the matching local runtime preflight.

## Security Notes

- Treat `.env`, Modal secrets, presigned URLs, and private workspace URLs as
  credentials.
- Rotate credentials that appear in logs, screenshots, issues, or chat.
- Keep bucket writes private. Public access should be read-only.
- Never attach `R2_PUBLIC_URL`, a custom domain, or an `r2.dev` development URL
  to `R2_UPLOAD_BUCKET`. `R2_RESULTS_BUCKET` is the only public-read bucket.
- Raw source files are not deleted by the application after processing. They
  persist in the private input bucket until its lifecycle rule removes them;
  configure and verify the one-day `uploads/` expiration before using cloud
  processing.
- Prefer a custom domain for public results; `r2.dev` is a rate-limited
  development endpoint.
- Use a strong `MODAL_AUTH_TOKEN` and an exact `TRUSTED_UPLOAD_ORIGINS` list.
- Test with deidentified or synthetic data before using research data.
