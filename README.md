<h1 align="center">📄 LibraPDF-Converter</h1>

<p align="center">
  Backend for the <b>Air Printer "Convertation"</b> feature.<br>
  Upload a document, get a PDF back.
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white">
  <img alt="Express" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="CloudConvert" src="https://img.shields.io/badge/CloudConvert-API%20v2-2f6fdb">
  <img alt="LibreOffice" src="https://img.shields.io/badge/LibreOffice-headless-18A303?logo=libreoffice&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white">
</p>

---

## ✨ What it does

```
 iOS / Android app ──(file)──▶ server ──▶ ☁️ CloudConvert ──▶ 📕 PDF ──▶ app
                                  │             ✖ fails / no key / timeout
                                  └──▶ 🖥 our LibreOffice ──▶ 📕 PDF ──▶ app
```

The response header `X-Converted-By` says which engine did the job: `cloudconvert` or `libreoffice`.

Files are checked, converted, and **deleted right after** (also at CloudConvert; if that delete fails we retry, and CloudConvert removes it itself after 24 hours). No database, no accounts.

## 📚 Supported formats

| Type | Extensions | Status |
|---|---|---|
| Word / text | `.doc` `.docx` `.dot` `.dotx` `.rtf` `.odt` `.txt` `.html` `.htm` | ✅ `.doc` `.docx` `.rtf` `.txt` tested |
| Spreadsheets | `.xls` `.xlsx` `.ods` `.csv` | ⚠️ `.xls` tested |
| Presentations | `.ppt` `.pptx` `.odp` | ⚠️ `.ppt` tested |
| Apple iWork | `.pages` `.numbers` `.key` | ❌ unreliable |

Details: [docs/KNOWN_PROBLEMS.md](docs/KNOWN_PROBLEMS.md)

## 🚀 Quick start

**1. Install LibreOffice** (needed for the real conversion)
```bash
brew install --cask libreoffice
export SOFFICE_PATH=/Applications/LibreOffice.app/Contents/MacOS/soffice
```

**2. Run the server**
```bash
npm install
API_KEY=change-me RATE_LIMIT_DISABLED=true npm start
```
That is the quick local test (no Redis, no rate limit). For the real setup, copy `.env.example` to `.env`, fill in `API_KEY`, the two `UPSTASH_REDIS_REST_*` values and (optional) `CLOUDCONVERT_API_KEY`, then run `npm run start:env`.
Without a CloudConvert key the server uses only LibreOffice.

**3. Convert a file**
```bash
curl -H "X-API-Key: change-me" -H "X-Device-ID: local-test-device-0001" \
  -F file=@report.docx http://localhost:3000/convert -o report.pdf
```

Or save the result straight to your Desktop:
```bash
scripts/to-desktop.sh ~/Downloads/report.docx
```

## 🐳 Docker

Documents are untrusted input, so run it locked down:

```bash
docker build -t librapdf-converter .
docker run -p 3000:3000 --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --cpus 2 --pids-limit 256 \
  -e API_KEY=change-me -e CLOUDCONVERT_API_KEY=your-key librapdf-converter
```

> 💡 If you can, also block the container's outbound network at the host or firewall level.

### 🏢 Two products, two servers
Printer 1 and Printer Android must have separate servers. One repository, two Fly.io apps, each with its own hostname, `API_KEY`, Redis database and CloudConvert key, deployed together by one workflow. See [docs/DEPLOY_FLY.md](docs/DEPLOY_FLY.md).

### 📦 How big is it, and what hosting do I need?

These are **estimates** (Docker is not installed on the dev Mac, so the image was not built yet). After your first build, run `docker images librapdf-converter` to see the real size.

| Part of the image | Size on disk |
|---|---|
| Node 26 (Debian slim) | ~250 MB |
| LibreOffice (Writer, Calc, Impress) | ~500–700 MB |
| Fonts (Noto incl. Chinese/Japanese/Korean, emoji, Carlito/Caladea) | ~200–300 MB |
| Our code and packages | ~10 MB |
| **Total** | **~1.2–1.5 GB** (about 0.5–0.7 GB compressed in a registry) |

Without `fonts-noto-cjk` it is about 100–150 MB smaller (but Chinese, Japanese and Korean show as empty boxes).

| Hosting needs | Value |
|---|---|
| RAM | **2 GB** (uploads live in RAM with `--tmpfs /tmp`) |
| CPU | 2 cores |
| Disk | 4 GB or more free |
| Price | about $10–15 per month for a 2 GB plan (check your host) |

CloudConvert and Upstash run on their own servers and use no space here.

## 🔌 API

| Method | Path | Description |
|---|---|---|
| `POST` | `/convert` | Multipart field `file` → returns `application/pdf` |
| `GET` | `/formats` | List of supported extensions |
| `GET` | `/health` | Liveness check → `{"ok": true}` |

Send your `API_KEY` as the `X-API-Key` header and a random per-install ID as the `X-Device-ID` header (16–64 letters, digits or dashes). The server will not start without `API_KEY`.

### Status codes

| Code | Meaning |
|---|---|
| `200` | ✅ PDF returned |
| `400` | No file sent, or missing/invalid `X-Device-ID` |
| `401` | Wrong or missing API key |
| `413` | File too large |
| `429` | Too many requests from this device (default 10 per minute, 500 per day). Retry after the `Retry-After` seconds |
| `415` | Unsupported type, or content doesn't match the extension |
| `422` | Conversion failed (broken or password-protected file) |
| `503` | Server busy (too many uploads or LibreOffice full), retry after the `Retry-After` seconds |
| `504` | Conversion timed out |

Errors are JSON: `{"error": "message"}`

## ⚙️ Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `API_KEY` | – | **Required.** Clients must send it as `X-API-Key`. Server will not start if it is empty |
| `UPSTASH_REDIS_REST_URL` | – | **Required.** Redis address for the rate limit (Upstash dashboard → REST API). Must start with `https://` |
| `UPSTASH_REDIS_REST_TOKEN` | – | **Required.** Redis token. Keep it secret. The server checks both at startup and will not start if they are wrong |
| `RATE_LIMIT_PER_MINUTE` | `10` | Requests per device per minute |
| `RATE_LIMIT_PER_DAY` | `500` | Requests per device per day |
| `RATE_LIMIT_DISABLED` | – | `true` = no rate limit. **Local testing only** |
| `MAX_UPLOADS` | `10` | Requests handled at the same time. More get `503` before the file is stored |
| `MAX_UPLOAD_MB_TOTAL` | `500` | Total size (MB) of files handled at the same time. Over this gets `503`. Lower it if the server has little memory |
| `MAX_FILE_MB` | `50` | Max upload size. Keep `--memory` in Docker at about 40× this number in MB (50 → 2g), because `/tmp` is in RAM |
| `MAX_CONCURRENT` | `2` | Conversions at the same time |
| `CONVERT_TIMEOUT_MS` | `60000` | Kill a conversion after this time. Seeing many `504`? Try `90000` |
| `SOFFICE_PATH` | `soffice` | Path to the LibreOffice binary |
| `CLOUDCONVERT_API_KEY` | – | Turns on CloudConvert as the first engine. Without it, only LibreOffice is used |
| `CLOUDCONVERT_SANDBOX` | `false` | `true` = use CloudConvert sandbox (free testing) |
| `CLOUDCONVERT_TIMEOUT_MS` | `45000` | Give up on CloudConvert after this time, then fall back. Big files may need `90000`. Keep the app timeout (240 s) longer than the two timeouts together |

## 🧪 Tests

```bash
npm test
```
25 tests (CloudConvert and Redis are tested against fake local servers, no real keys needed). The real-conversion tests are skipped if `soffice` is not installed.

## 🗂 Project structure

```
src/
  server.js     starts the server
  app.js        routes
  convert.js    picks the engine: CloudConvert, then LibreOffice (timeout, locked-down profile)
  cloudconvert.js  CloudConvert API client
  ratelimit.js  rate limit per device (Upstash Redis)
  validate.js   checks file content matches its extension
test/           node:test suite
scripts/        to-desktop.sh helper
docs/           guides (below)
docs/diagrams/  diagram sources (SVG) and generate.py
.env.example    all settings, copy to .env
Dockerfile
fly.printer1.toml, fly.printer-android.toml   Fly.io settings, one per product
.github/workflows/deploy.yml   deploys the same revision to both Fly apps
```

## 🧭 Status

| Done | Still to do |
|---|---|
| ✅ Convert API, validation, tests | ⬜ Fix big `.doc` failing at CloudConvert |
| ✅ CloudConvert first, LibreOffice fallback | ⬜ Test .xlsx, .pptx, .ods, .odp and iWork files (.csv .html .odt .rtf work) |
| ✅ Docs and diagrams | ⬜ Check the new fonts after the first Docker build (CJK, Arabic, emoji) |
| ✅ Fonts added to the Dockerfile (CJK, Arabic, emoji) | ⬜ Measure the real image size after the first build |
| ✅ Real CloudConvert test (live key) | ⬜ Stronger caller check (Apple App Attest) |
| ✅ Rate limit per device (Upstash Redis), tested live | ⬜ Move the Upstash and CloudConvert keys to the hosting settings |
| | ⬜ Isolate LibreOffice files per job (separate container or sandbox) |
| ✅ Required `API_KEY`, upload limits (count + MB), safer LibreOffice | ⬜ Sandbox test of CloudConvert |
| ✅ Swift `ConverterService` (retry on 503, PDF skips server) | ⬜ Build it in Xcode and run on a device |
| ✅ Docker image written (Node 26) | ⬜ Build and test the Docker image (Docker not installed here) |
| ✅ Fly.io files for two apps + deploy workflow (not tested) | ⬜ Get the Fly organization, create both apps, deploy, HTTPS, set secrets |
| | ⬜ Connect the iOS and Android apps |
| | ⬜ Final Privacy Policy and Terms |


## 📖 Docs

| File | For |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Diagrams: how a request flows. PDF: [AirPrinter-Converter-Diagrams.pdf](docs/AirPrinter-Converter-Diagrams.pdf) |
| [DEPLOY_FLY.md](docs/DEPLOY_FLY.md) | Deploy two separate Fly.io apps (Printer 1 and Printer Android), one workflow for both. Prepared, not tested |
| [SWIFT_INTEGRATION.md](docs/SWIFT_INTEGRATION.md) | iOS and Android developers: how to connect. Code: [ConverterService.swift](docs/ConverterService.swift) |
| [KNOWN_PROBLEMS.md](docs/KNOWN_PROBLEMS.md) | Format, font, scaling and security limits |
| [TECH_STACK.md](docs/TECH_STACK.md) | What we use and which versions |
| [LEGAL_NOTES.md](docs/LEGAL_NOTES.md) | What to put in Privacy Policy and Terms |
