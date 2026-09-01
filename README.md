# Batch Export API

HTTP API for the website: upload a `.stp`, `.step`, or `.f3d` assembly and download a zip of STEP parts. End users do not need an Autodesk account. Fusion runs on Autodesk Platform Services; CAD bytes go browser → APS OSS, not through this API.

**Base URL**

```
https://5nskafqvcdt3szwdrr45yegycu0txqsp.lambda-url.us-east-1.on.aws
```

CORS allows `GET` and `POST` from any origin (`content-type`). JSON request bodies. Send the `jobToken` in the body, not in the URL.

Anyone with the URL can start jobs and consume APS Fusion time.

---

## Flow

```
GET  /                 Health check
POST /uploads          Get signed OSS PUT URLs + jobToken
     Browser PUTs the file to those URLs (not to this API)
POST /jobs             Finalize upload and start Fusion
POST /status           Poll until done (every ~5 s)
POST /download         Signed URL for the zip (only after success)
POST /cleanup          Delete OSS input and zip (optional)
```

Do not POST the CAD file to Lambda. The payload limit is too small; `/uploads` exists so the browser uploads directly to OSS.

---

## Endpoints

### `GET /`

```json
{ "ok": true, "service": "batch-export" }
```

### `POST /uploads`

**Request**

```json
{ "filename": "assembly.stp", "sizeBytes": 2733076 }
```

`filename` must end in `.stp`, `.step`, or `.f3d`. `sizeBytes` must be `> 0` and at most **125 MB** (25 × 5 MB parts).

**Response**

```json
{
  "jobToken": "<signed token>",
  "inputObjectKey": "inputs/<uuid>.stp",
  "partSize": 5242880,
  "urls": ["https://..."]
}
```

PUT each part in order. Part `i` is bytes `[i * partSize, min((i+1) * partSize, sizeBytes))`. Use `Content-Type: application/octet-stream`. Small files get one URL.

### `POST /jobs`

Call after all PUTs succeed.

```json
{ "jobToken": "<token from /uploads>" }
```

```json
{
  "jobToken": "<updated token>",
  "workItemId": "<aps work item id>",
  "status": "pending"
}
```

Use the **new** `jobToken` for later calls.

### `POST /status`

```json
{ "jobToken": "<token from /jobs>" }
```

```json
{
  "status": "inprogress",
  "done": false,
  "reportUrl": "https://..."
}
```

Stop polling when `done` is `true`. `status` is then one of:

`success`, `failed`, `cancelled`, `failedDownload`, `failedUpload`, `failedInstructions`, `failedLimitProcessingTime`, `failedLimitDataSize`, `failedMissingOutput`

Jobs time out after **900 seconds** on APS. Typical STEP import is seconds to several minutes. On failure, `reportUrl` has Fusion worker logs.

### `POST /download`

Only when `status` is `success`.

```json
{ "jobToken": "<token from /jobs>" }
```

```json
{ "url": "https://...", "size": 1878000 }
```

`GET` `url` from the browser (signed OSS). Do not proxy the zip through this API.

### `POST /cleanup`

```json
{ "jobToken": "<token>" }
```

```json
{ "ok": true }
```

Deletes the OSS input and zip. Safe after the user has the file. Objects also expire after 24 hours if this is skipped.

---

## Errors

Failed requests return `{ "error": "<message>" }` with `400` or `401` (invalid or expired token). Tokens last **45 minutes**.

---

## Zip contents

The download is a zip of STEP files plus:

**`parts-manifest.json`** — each exported STEP except the full-assembly file:

| Field | Meaning |
|-------|---------|
| `part` | Output filename |
| `quantity` | Instance count |
| `locations` | Assembly paths |
| `mirrors` | Optional mirror-variant filenames |

**`bounding-boxes.json`** — oriented box per **leaf** part only (`unit` is always `cm`): `part`, `length`, `width`, `height`.

Export order: full assembly (if more than one body) → sub-assemblies → whole parts → body splits from multi-body parts. Duplicates are merged by part number and by geometry; mirrors stay as separate files.

| Input | |
|-------|--|
| `.stp`, `.step` | STEP |
| `.f3d` | Fusion archive |
