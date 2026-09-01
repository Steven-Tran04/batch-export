# Batch Export — Design Automation Worker

Fusion 360 Design Automation service that exports assembly components and bodies as individual STEP files, packaged in a zip archive.

This repo contains:

- **`batch-export.ts`** — Fusion worker that runs inside Autodesk Platform Services (APS) Design Automation
- **`scripts/`** — CLI tools to deploy the worker and a **reference implementation** for submitting export jobs

The website/backend team clones this repo, uses the scripts below, and wires the export flow into their own API. They do **not** run `batch-export.ts` on their server — that runs in APS. They also do **not** need to redeploy the Fusion worker unless export logic in `batch-export.ts` changes (that is handled separately via `npm run appbundle`).

---

## Getting started (website backend)

```bash
git clone https://github.com/Steven-Tran04/batch-export.git
cd batch-export
npm install
cp .env.example .env
# Fill in APS credentials (shared separately)
npm run export -- --input path/to/test.stp
```

If the CLI export succeeds, APS credentials and the deployed Activity are configured correctly. Next step: port the same flow into your web backend.

### Files to use

| File | Purpose |
|------|---------|
| `scripts/export-service.ts` | Submit job, poll status, download zip, OSS cleanup |
| `scripts/aps-common.ts` | APS tokens, OSS upload/download/delete |
| `scripts/create-workitem.ts` | Full end-to-end reference (CLI version of the website flow) |

### Files you can ignore

| File | Why |
|------|-----|
| `batch-export.ts` | Fusion worker — already deployed on APS |
| `scripts/create-appbundle.ts` | Worker deployment only |
| `scripts/create-activity.ts` | Activity deployment only |
| `scripts/aps-auth.ts` | Hub/OAuth path — not needed for drag-and-drop |

---
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

## Deployed resources

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

**Reference implementation:** `scripts/create-workitem.ts` and `scripts/export-service.ts`. Import or copy these into your backend routes.

### Hosting the website API

This repo does **not** include a hosted API service. The website team implements the suggested endpoints below in whatever stack fits their hosting (Node/Express, Python/FastAPI, PHP, etc.) and deploys it separately from the GoDaddy frontend if shared hosting limits apply. **AWS App Runner** is a straightforward option for a small containerized API; reuse `scripts/export-service.ts` directly if the backend is Node/TypeScript.

### Suggested API surface

```
POST   /api/export              Upload file (or accept OSS key), start job → { jobId }
GET    /api/export/:jobId       Poll status → { status, error? }
GET    /api/export/:jobId/download   Stream or redirect to zip (only when status = success)
```

For downloads, **redirect the browser to the OSS signed URL** (`getExportDownloadUrl()` in `scripts/export-service.ts`) instead of downloading the zip to your server and re-serving it. That removes a full network hop and is usually the biggest OSS speed win.

Uploads and CLI downloads use parallel direct-to-S3 transfers in `scripts/aps-common.ts` (up to 25 upload parts and 6 concurrent download ranges for large files).

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

The worker walks the assembly tree and exports STEP files in this order (assembly and component exports run **before** body splitting mutates the design):

1. **Full assembly** — one STEP for the whole design when it contains more than one body
2. **Sub-assemblies** — named components that have child occurrences
3. **Whole parts** — named leaf components (own bodies, no children), exported as one STEP with all bodies
4. **Body splits** — only from **multi-body** parts; identical geometry across the assembly is deduplicated into one file per unique body shape

**Naming**

| Export type | Filename pattern |
|-------------|------------------|
| Assembly, sub-assembly, whole part | Plain part number (e.g. `112801975.step`) |
| Body export (multi-body part only) | `{partNumber}_1`, `_2`, … |
| Unlabeled bodies in a flat assembly | `part_1`, `part_2`, … |

**Deduplication**

- **By part number** — if multiple components share the same name, export one STEP file; `parts-manifest.json` lists every placement and `quantity` counts **component instances**, not bodies within a part
- **By geometry** — rotated copies of the same body shape export once; `quantity` on body-level entries counts matching body instances across the assembly
- **Surface bodies** — sheets have no mass, so they are matched by area, oriented-box extents, face/edge counts, face layout around the area centroid, and edge lengths. Mirror detection uses area inertia instead of mass inertia; degenerate (planar or symmetric) sheets are treated as the same family rather than as mirrors
- **Mirrors** — mirrored variants stay as separate files and are linked via optional `mirrors` in the manifest (shape match + opposite inertia handedness; steel is applied temporarily to **solid** bodies for comparison, then restored before export)

**Manifest**

`parts-manifest.json` lists each exported STEP (excluding the full-assembly file) with:

| Field | Meaning |
|-------|---------|
| `part` | Output filename |
| `quantity` | Instance count (component placements for whole parts; body instances for body splits) |
| `locations` | Assembly paths for each instance |
| `mirrors` | Optional list of mirror-variant filenames |

**Bounding boxes**

`bounding-boxes.json` lists a tight oriented bounding box for each **leaf** STEP only (named parts and split bodies from multi-body parts). Full-assembly and sub-assembly files are omitted.

| Field | Meaning |
|-------|---------|
| `unit` | Always `cm` (Fusion internal length unit) |
| `parts[].part` | Output filename, joinable with `parts-manifest.json` |
| `parts[].length` | Oriented box length (cm) |
| `parts[].width` | Oriented box width (cm) |
| `parts[].height` | Oriented box height (cm) |

Also packs all STEP files plus `parts-manifest.json` and `bounding-boxes.json` into `exports.zip` and uploads to OSS via the `OutputZip` parameter.

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

# Keep input/output in OSS after export (debugging):
npm run export -- --input "path\to\assembly.stp" --keep-oss
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
| OSS upload/download | Seconds (parallel direct-to-S3 transfers) |
| STEP import (large assembly) | Several minutes |
| Export + zip | Seconds to minutes |
| WorkItem timeout | **900 seconds** (15 min) |

Poll WorkItem status every ~5 seconds. Show a progress indicator in the UI for large files.

---

## Security and operations

- Keep all APS credentials on the **backend** only
- Add file size limits and rate limiting on your API
- **Delete OSS objects after each job** — the CLI does this automatically after a successful download (input + output zip). Pass `--keep-oss` to skip cleanup for debugging. The website backend should call `deleteBucketObject()` from `scripts/aps-common.ts` after delivering the zip to the user
- As a safety net, set OSS lifecycle rules to delete `inputs/*` and `exports/*` after 24–72 hours
- Monitor APS Design Automation usage and billing
- For production, consider promoting the activity alias from `dev` to `prod`

---

## Project layout

```
batch-export.ts                 Fusion worker (deployed to APS)
BatchExportAppBundle/
  PackageContents.xml             AppBundle manifest
scripts/
  export-service.ts             Export logic to use in your backend
  create-workitem.ts            CLI + end-to-end reference
  aps-common.ts                 Tokens, OSS upload/download, helpers
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
