# Known problems

## 1. Format problems

| Format | Problem |
|---|---|
| `.pages` `.numbers` `.key` (Apple) | Often fail or look wrong. Not reliable. Most risky. |
| `.pptx` `.ppt` | Fonts, charts, SmartArt, animations can shift or flatten. |
| `.xlsx` `.xls` `.csv` | Wide sheets split across many pages. Huge sheets can time out. Non-UTF-8 CSV shows garbled text. |
| `.docx` `.doc` | Mostly fine. Calibri etc. are replaced, so lines can move. Comments / tracked changes may look odd. |
| `.html` | No external CSS, images or scripts. Looks plain. |
| `.txt` `.rtf` `.odt` | Fine. |
| Password-protected | Always fails (422). |
| Broken file | Always fails (422). |
| Images, `.pdf`, `.md`, `.epub` | Not supported. |

**Tested for real (small files, LibreOffice):** `.doc` `.docx` `.rtf` `.odt` `.txt` `.html` `.csv`. **Not tested yet:** `.xls` `.xlsx` `.ods` `.ppt` `.pptx` `.odp` and iWork files (`.pages` `.numbers` `.key`).

## 2. CloudConvert
- **Tested with a real (live) key:** a small `.docx` and a 1 MB `.docx` worked. A big 1 MB `.doc` failed at CloudConvert (`EXPORT_FAILED`) and LibreOffice did it. Sandbox is untested.
- **Costs money** per conversion (and has a free daily limit). If the key runs out of credits, every request falls back to LibreOffice, which is slower and gets 503 under load. Watch your balance.
- **Slower worst case:** CloudConvert times out after 45 s, then LibreOffice runs. A bad file can take ~100 s before it fails.
- **Privacy:** user files leave our server and go to CloudConvert. We delete the job right after (retry if it fails; CloudConvert keeps it at most 24 hours if all retries fail). It must be in the Privacy Policy (see `LEGAL_NOTES.md`).
- **Two engines = two looks.** The same file can look a bit different depending on which engine did it.
- If CloudConvert is the main engine, the "fonts" and "format" problems below mostly apply to the fallback only.

## 3. Fonts
The Dockerfile now installs Noto fonts (Chinese, Japanese, Korean, Arabic, Hindi and others), emoji, and Carlito/Caladea (look like Calibri/Cambria in Word files). This only matters when LibreOffice does the work (CloudConvert has its own fonts).
- **Not tested yet:** Docker is not installed on this Mac, so the image was not built. After the first build, convert a file with Chinese, Arabic and emoji and check there are no empty boxes.
- The image gets bigger (about 200–300 MB more; `fonts-noto-cjk` is the biggest part, 100–150 MB). Total image: about 1.2–1.5 GB (estimate, see README). Some rare fonts (for example Word's own Arial or Times New Roman) are replaced by look-alikes, so line breaks can differ a little.

## 4. Too many users

| Users | Result |
|---|---|
| ~100 | One small server (2 GB RAM, 2 CPU) is OK. |
| ~1000 | One server is **not** enough. Users get 503 "busy". |

With CloudConvert on, most load goes to them, so our server is much less busy. Only the fallback uses our CPU.
Why (fallback): each conversion starts LibreOffice (5–10 seconds, 150–500 MB RAM). Default is 2 at the same time (`MAX_CONCURRENT`). The API also takes only 10 requests at a time (`MAX_UPLOADS`) and 500 MB of files at a time (`MAX_UPLOAD_MB_TOTAL`). The rest get 503.

**Fixes, in order:**
1. Run 2–3 copies of the Docker container.
2. Add a job queue (Redis / SQS): upload → get job ID → poll for result.
3. ~~Add a rate limit per user (Redis).~~ **Done:** 10 per minute and 500 per day per device (`X-Device-ID`, Upstash Redis).
   **Limit:** the device ID is made by the app, so a determined person can invent new IDs. For a stronger check, add Apple App Attest (iOS) / Play Integrity (Android).
4. Keep LibreOffice running between jobs (faster).

## 5. Security
- The API key inside the app can be extracted. It only stops casual abuse. Use subscription check or Apple App Attest for real protection.
- Users upload private documents. Files are deleted right after conversion on our server and at CloudConvert (at most 24 hours there if the delete call fails). Mention this in the privacy policy and App Store privacy details.
- Documents are untrusted. Run Docker with the hardened command in `README.md`.
- **LibreOffice is only half isolated (to do).** It gets only the environment variables it needs (no API keys). But it still runs with the same file permissions as the server, so in theory it can read other uploads in the temp folder. Macros and external links are off, and upload names are random, which lowers the risk. **Fix:** run LibreOffice in a separate container or user that sees only its own job folder, or in a sandbox per job (for example `bubblewrap`; it may not work with `--cap-drop ALL`). Test this in a real container when you deploy.

## 6. Other
- First conversion after start is slower (~6 s).
- Max file size: 50 MB (needs a 2 GB server; see README, Docker). Timeout: 60 s. Both can be changed (`MAX_FILE_MB`, `CONVERT_TIMEOUT_MS`). If you raise the timeouts, also raise the app timeout (240 s now) and check the hosting limit for waiting on a response.
- Server is not deployed yet. Phones cannot reach `localhost`. Deploy plan: two separate Fly.io apps (Printer 1 and Printer Android), see [DEPLOY_FLY.md](DEPLOY_FLY.md). The files are prepared but **not tested** (no Fly account yet).
- Each product needs its own `API_KEY`, Upstash database and CloudConvert key. If two products share any of them, they are not isolated.
- The code is on GitHub. Push after each commit so it stays backed up.
