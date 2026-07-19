# Optional Cloud Processing Setup

VoxelLab does not need a cloud service to open local files. This guide is for
operators who want to run the optional Modal processing path with Cloudflare R2
object storage.

Cloud processing uploads selected source files to infrastructure you control.
Confirm that your data policy permits this before enabling it. VoxelLab is not
for clinical use.

## Requirements

- Node.js 22.12.0
- Python 3.11 or newer
- A Cloudflare account with R2 enabled
- A Modal account

Install the cloud dependencies:

```bash
npm run setup -- --pipeline --cloud
```

## Create the R2 Bucket

1. Create an R2 bucket in the Cloudflare dashboard.
2. Create S3-compatible credentials with read and write access to that bucket.
3. Configure a public read URL through an `r2.dev` subdomain or custom domain.
4. Add CORS rules for every browser origin that may upload directly.

Example CORS policy:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:8000", "https://viewer.example.com"],
    "AllowedMethods": ["GET", "HEAD", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Use the narrowest origins and credentials that fit your deployment.

## Configure Local Secrets

Create a local `.env` file and set these values:

```bash
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=scan-data
R2_PUBLIC_URL=https://<public-r2-host>

MODAL_WEBHOOK_BASE=https://<modal-deployment-base>
MODAL_AUTH_TOKEN=<long-random-token>
TRUSTED_UPLOAD_ORIGINS=http://127.0.0.1:8000
```

Do not commit `.env`. Use R2 S3 client credentials, not a Cloudflare account
token.

Optional `MRI_VIEWER_MODAL_*` variables control GPU type, memory, temporary
disk, concurrency, retries, and transfer workers. Start with the application
defaults and adjust them only after measuring your workload and account limits.

## Configure Modal

Create a Modal secret named by `MRI_VIEWER_MODAL_R2_SECRET`. The default name is
`r2-creds`. It must provide `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`, and
`MODAL_AUTH_TOKEN` to `python/modal_app.py`. Then deploy:

```bash
. .venv/bin/activate
modal deploy python/modal_app.py
```

Record the deployed endpoint base as `MODAL_WEBHOOK_BASE`, then run the local
configuration preflight:

```bash
npm run check:cloud
```

The preflight checks configuration and local executables. It does not upload
files or start a cloud job.

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
- Use a strong `MODAL_AUTH_TOKEN` and an exact `TRUSTED_UPLOAD_ORIGINS` list.
- Test with deidentified or synthetic data before using research data.
