# Tech stack

## What it is
Backend service for the Air Printer "Convertation" feature. Takes a document, returns a PDF.

## Main parts

| Part | What | Version | Why |
|---|---|---|---|
| Node.js | Runs the server | 26.10.0 (local) / 26 LTS (Docker image `node:26-bookworm-slim`) | Needs 24 or newer |
| Express | Web framework (routes, responses) | 4.22.3 (`^4.21.0`) | Simple HTTP API |
| Multer | Receives file uploads | 2.5.0 (`^2.5.0`) | Handles `multipart/form-data` |
| CloudConvert | **First choice.** Online conversion API (v2) | API v2, called with built-in `fetch` | Better quality for hard files, no load on our server |
| LibreOffice (`soffice`, headless) | **Fallback.** Converts when CloudConvert fails or is off | 26.8.2.2 (local Mac) / Debian package in Docker | Reads .doc/.docx/.xls/.ppt etc. |
| Docker | Packaging and deployment | Base: Debian 12 (bookworm) | Same setup everywhere |

Node built-ins only (no extra packages): `node:test` (tests), `node:child_process` (starts LibreOffice), `node:crypto` (API key check).

## Dependencies
Only 2 runtime packages: `express`, `multer`. No dev dependencies. No database. Two cloud services: CloudConvert (needs an account + `CLOUDCONVERT_API_KEY`; pay per conversion) and Upstash Redis (rate limit counters; free plan; needs `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).

## Why Express and not NestJS
Decision: stay with **Express**. The service is small (one main route), and all upload controls from the review are already built here: required API key, limits on requests and megabytes, rate limit per device in Upstash Redis (10 per minute, 500 per day), and tests. NestJS would only add a rewrite. If the team later prefers NestJS, the KMA template has the same Redis rate limiter and the logic in `src/ratelimit.js` can be moved over.

## Project files
- `src/server.js` — starts the server
- `src/app.js` — routes (`/convert`, `/formats`, `/health`)
- `src/convert.js` — chooses engine, runs LibreOffice, timeout, locked-down profile
- `src/cloudconvert.js` — CloudConvert client
- `src/ratelimit.js` — rate limit per device (Upstash Redis)
- `src/validate.js` — checks file content matches its extension
- `test/` — 25 tests (`npm test`)
- `.env.example` — all settings; run with `npm run start:env`
- `scripts/to-desktop.sh` — converts a file and saves the PDF to Desktop
- `Dockerfile` — image with LibreOffice and fonts

## Docs tooling
Diagram pages in `docs/diagrams/` are SVG files made by `generate.py` (plain Python 3, no packages) and turned into PDF with LibreOffice: `soffice --headless --convert-to pdf file.svg`. The Mermaid diagrams in `ARCHITECTURE.md` render on GitHub.

## Config (environment variables)
`PORT` (3000), `API_KEY` (required), `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (required), `RATE_LIMIT_PER_MINUTE` (10), `RATE_LIMIT_PER_DAY` (500), `RATE_LIMIT_DISABLED`, `MAX_UPLOADS` (10), `MAX_UPLOAD_MB_TOTAL` (500), `MAX_FILE_MB` (50), `MAX_CONCURRENT` (2), `CONVERT_TIMEOUT_MS` (60000), `SOFFICE_PATH`, `CLOUDCONVERT_API_KEY`, `CLOUDCONVERT_SANDBOX`, `CLOUDCONVERT_TIMEOUT_MS`.

## Infrastructure
- Not deployed yet. Git is local only (3 commits, no remote).
- Needs about 2 GB RAM per container (50 MB files, uploads live in RAM with `--tmpfs /tmp`).

## Note on versions
The Docker image installs LibreOffice from Debian bookworm, which is an older version than the 26.8 on this Mac. Output can differ slightly between them. Test on the Docker image before release.
