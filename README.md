# Batch Export — Design Automation Worker

Fusion 360 Design Automation service that exports assembly components and bodies as individual STEP files, packaged in a zip archive.

This repo contains:

- **`batch-export.ts`** — Fusion worker that runs inside Autodesk Platform Services (APS) Design Automation
- **`scripts/`** — CLI tools to deploy the worker and a **reference implementation** for submitting export jobs

The website/backend team does **not** run `batch-export.ts` on their server. They call APS APIs to upload a file, submit a WorkItem, poll for completion, and download the result zip.

---

## Deployed resources

These are already registered on APS (update versions via `npm run appbundle` / `npm run activity`):

| Resource | ID |
|----------|-----|
| Activity | `{APS_NICKNAME}.BatchExportActivity+dev` |
| AppBundle | `{APS_NICKNAME}.BatchExportAppBundle+dev` |
| OSS bucket | `batch-export-output` (configurable via `APS_BUCKET_KEY`) |
| Region | `us-east` (configurable via `APS_REGION`) |
| Engine | `Autodesk.Fusion+Latest` |

With the default nickname `Phamtec`, the activity ID is:

```
Phamtec.BatchExportActivity+dev
```

---

## Website integration (drag-and-drop)

For a public upload form (`.stp`, `.step`, or `.f3d`), use the **OSS input path**. End users do **not** need an Autodesk account or OAuth sign-in.

```
User drops file
      ↓
Your backend: 2-legged token → upload to OSS → submit WorkItem
      ↓
Poll WorkItem status (~5 s interval)
      ↓
On success: download zip from OSS → return to user
```

### What your backend must implement

| Step | APS endpoint / action |
|------|------------------------|
| 1. Authenticate (server only) | `POST https://developer.api.autodesk.com/authentication/v2/token` (client credentials) |
| 2. Upload input file | OSS bucket API — see `uploadBucketObject()` in `scripts/aps-common.ts` |
| 3. Submit job | `POST https://developer.api.autodesk.com/da/{region}/v3/workitems` |
| 4. Poll status | `GET https://developer.api.autodesk.com/da/{region}/v3/workitems/{id}` |
| 5. Download result | OSS signed download — see `downloadBucketObject()` in `scripts/aps-common.ts` |

**Reference implementation:** `scripts/create-workitem.ts` (upload → submit → poll → download). Port this logic into your API routes.

### Suggested API surface

```
POST   /api/export              Upload file (or accept OSS key), start job → { jobId }
GET    /api/export/:jobId       Poll status → { status, error? }
GET    /api/export/:jobId/download   Stream or redirect to zip (only when status = success)
```

For large files (50 MB+), consider a two-step flow: backend returns OSS signed upload URLs, browser uploads directly to OSS, then backend submits the WorkItem with the object key only.

### WorkItem payload (STEP upload)

```json
{
  "activityId": "Phamtec.BatchExportActivity+dev",
  "arguments": {
    "TaskParameters": "{\"inputSource\":\"oss\",\"inputFormat\":\"step\",\"inputLocalName\":\"input.stp\"}",
    "InputStep": {
      "verb": "get",
      "url": "urn:adsk.objects:os.object:batch-export-output/inputs/{uuid}.stp",
      "headers": { "Authorization": "Bearer {2LO_access_token}" }
    },
    "OutputZip": {
      "verb": "put",
      "url": "urn:adsk.objects:os.object:batch-export-output/exports/{uuid}.zip",
      "headers": { "Authorization": "Bearer {2LO_access_token}" }
    }
  }
}
```

### WorkItem payload (F3D upload)

Use `InputF3d` instead of `InputStep`, and set TaskParameters to:

```json
{
  "inputSource": "oss",
  "inputFormat": "f3d",
  "inputLocalName": "input.f3d"
}
```

### TaskParameters summary

| Field | OSS path | Hub path (optional) |
|-------|----------|---------------------|
| `inputSource` | `"oss"` | omit (defaults to hub) |
| `inputFormat` | `"step"` or `"f3d"` | — |
| `inputLocalName` | `"input.stp"` or `"input.f3d"` | — |
| `hubId` | — | Fusion Team hub ID |
| `fileURN` | — | Fusion file URN |

Hub path also requires WorkItem argument `adsk3LeggedToken` (3-legged OAuth). Not needed for drag-and-drop.

### Terminal WorkItem statuses

Stop polling when status is one of:

`success`, `failed`, `cancelled`, `failedDownload`, `failedUpload`, `failedInstructions`, `failedLimitProcessingTime`, `failedLimitDataSize`, `failedMissingOutput`

On failure, fetch the WorkItem `reportUrl` for detailed Fusion worker logs.

---

## Supported input formats

| Extension | Activity parameter | Worker local name |
|-----------|-------------------|-------------------|
| `.stp`, `.step` | `InputStep` | `input.stp` |
| `.f3d` | `InputF3d` | `input.f3d` |

### Export behavior

- Walks the assembly component tree
- Exports each component as a STEP file
- Multi-body components are split into one STEP per body
- Also exports a full-assembly STEP file
- Packs all STEP files into `exports.zip` and uploads to OSS via the `OutputZip` parameter

**STEP vs F3D:** STEP imports open in Direct Modeling mode inside Fusion. Multi-body splitting uses body copy instead of cut/paste. Native `.f3d` files preserve full parametric behavior.

---

## Environment variables

Copy `.env.example` to `.env` and fill in values. **Never expose `APS_CLIENT_SECRET` in the browser.**

| Variable | Required | Purpose |
|----------|----------|---------|
| `APS_CLIENT_ID` | Yes | APS app client ID |
| `APS_CLIENT_SECRET` | Yes | Server-side only |
| `APS_NICKNAME` | Yes | Prefix in activity/appbundle IDs |
| `APS_BUCKET_KEY` | Yes (website path) | OSS bucket for inputs and output zips |
| `APS_REGION` | No | Default `us-east` |

Hub-path testing only (not needed for website):

| Variable | Purpose |
|----------|---------|
| `APS_HUB_ID` | Default Fusion Team hub |
| `APS_FILE_URN` | Default Fusion file |
| `APS_CALLBACK_URL` | OAuth callback for `npm run auth` |

---

## Local testing (CLI)

Requires Node.js 18+.

```powershell
npm install
copy .env.example .env
# Edit .env with APS credentials

# Test drag-and-drop path (same flow the website should use):
npm run export -- --input "path\to\assembly.stp"

# Re-use an already-uploaded OSS object:
npm run export -- --oss-key inputs/some-uuid.stp
```

Successful runs download the zip to `output/{workItemId}.zip`.

Hub-based export (requires one-time OAuth):

```powershell
npm run auth
npm run export
```

---

## Performance and limits

| Phase | Typical duration |
|-------|------------------|
| OSS upload/download | Seconds |
| STEP import (large assembly) | Several minutes |
| Export + zip | Seconds to minutes |
| WorkItem timeout | **900 seconds** (15 min) |

Poll WorkItem status every ~5 seconds. Show a progress indicator in the UI for large files.

---

## Security and operations

- Keep all APS credentials on the **backend** only
- Add file size limits and rate limiting on your API
- Set OSS lifecycle rules to delete `inputs/*` and `exports/*` after 24–72 hours
- Monitor APS Design Automation usage and billing
- For production, consider promoting the activity alias from `dev` to `prod`

---

## Project layout

```
batch-export.ts                 Fusion worker (deployed to APS)
BatchExportAppBundle/
  PackageContents.xml             AppBundle manifest
scripts/
  create-workitem.ts              Reference: submit + poll + download
  aps-common.ts                   Tokens, OSS upload/download, helpers
  create-appbundle.ts             Deploy worker updates
  create-activity.ts              Deploy activity updates
  aps-auth.ts                     Fusion Team OAuth (hub path only)
  cli-args.ts, port-utils.ts, zip-store.ts
```

---

## Deploying worker updates

When export logic changes in `batch-export.ts`:

```powershell
npm run appbundle
```

Run `npm run activity` only if Activity parameters change (see `scripts/create-activity.ts`).

---

## Responsibilities

| Delivered in this repo | Website/backend team |
|------------------------|----------------------|
| Fusion export worker | Drag-and-drop UI |
| APS Activity + AppBundle | Backend API wrapping WorkItems |
| CLI reference implementation | Hosting, secrets management |
| OSS bucket setup | Rate limits, cleanup, monitoring |

For questions about APS credentials or deployed resource IDs, contact the person who handed off this repo.
