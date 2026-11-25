# Deploy to Fly.io: two separate apps (iOS and Android)

> **Status: both apps deployed by hand (steps 1–4) on 2026-11-26.** Checked: `/health`, `/convert` answered `200` via CloudConvert, and each app's key gets `401` on the other app. Each app uses its own paid CloudConvert account (step 5, done the same day). The GitHub workflow (step 6) has not run yet.
> App names follow the company Fly organization's convention (`<name>-production`); there is no `-development` app for now.

## The idea
- Two Fly apps from **one repository and one Dockerfile**: Printer 1 (the iOS app) and Printer Android.
- Each app has **its own** URL, `API_KEY`, Redis database and CloudConvert key.
- One GitHub workflow deploys the **same revision** to both apps.
- Each mobile app uses **only its own URL**, from upload to PDF.

| | Printer 1 (iOS) | Printer Android |
|---|---|---|
| Fly app | `printer1-converter-production` | `printer-android-converter-production` |
| Config file | `fly.printer1.toml` | `fly.printer-android.toml` |
| URL to start with | `https://printer1-converter-production.fly.dev` | `https://printer-android-converter-production.fly.dev` |
| Upstash Redis database | `printer1-converter-ratelimit` | `printer-android-converter-ratelimit` |
| `API_KEY`, CloudConvert key | its own | its own |
| GitHub environment + `FLY_API_TOKEN` | `printer1` | `printer-android` |
| Machine size | 2 GB RAM, 2 shared CPUs (approved) | same |

## Secrets vs settings
Both end up as environment variables in the app (`process.env`). If a name is in both, the secret wins.

| Where | What | Who can see it |
|---|---|---|
| **Fly secrets** (`fly secrets ...`) | `API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `CLOUDCONVERT_API_KEY` | Nobody: encrypted, `fly secrets list` shows names only |
| `[env]` in `fly.*.toml` | `PORT`, `MAX_FILE_MB`, `MAX_UPLOADS`, `MAX_UPLOAD_MB_TOTAL` (add `MAX_CONCURRENT` or timeouts only to change the defaults) | Everyone with access to the repository |
| GitHub environment secrets | `FLY_API_TOKEN` (one per app) | Nobody |

Never set on Fly: `RATE_LIMIT_DISABLED` (turns protection off), `CLOUDCONVERT_SANDBOX` (production uses the real CloudConvert), `SOFFICE_PATH` (not needed in Docker).

Your local `.env` is never used on Fly: `.dockerignore` excludes it and `fly deploy` does not read it. Use **new** keys for production; keep the local ones for development.

## Step 0: access and accounts (people do this)
1. **Fly:** use the company Fly organization `kma` (questions: Somalic in `#devops_intake`). Then `fly auth login` and `fly orgs list`.
2. **Upstash** (done): one Redis database per app at console.upstash.com, in the team account. Settings: primary region `eu-central-1` (Frankfurt), no read regions, eviction on, plan Pay as you go, no max budget. From the database's **REST API** section copy `UPSTASH_REDIS_REST_URL` and the standard `UPSTASH_REDIS_REST_TOKEN` (**not** the read-only one: the server writes counters). Do not use `fly redis create`: it gives a `redis://` database, and this server needs the REST API.
3. **CloudConvert:** one API key per app (Dashboard → Authorization → API Keys), scopes `task.read` and `task.write`. Separate account per product, see [LEGAL_NOTES.md](LEGAL_NOTES.md). Buy credits (Dashboard → Billing).
   **Until the company keys arrive** a temporary key from the development account is fine. Make a separate key for Fly (e.g. `fly-temp`, same scopes) so you can revoke it later without breaking local development. Credits belong to the account, so local, iOS and Android share its daily limit; above it the server falls back to LibreOffice. Users' files go to that account, so replace it before the store release (step 5).

Keep every value in a password manager, not in chat or notes.

## Step 1: create the two apps

```bash
fly apps create printer1-converter-production --org kma
fly apps create printer-android-converter-production --org kma
```

If a name is taken, pick another and put it in the `app = "..."` line of that `fly.*.toml`. The URL follows the name: `https://<name>.fly.dev`.

## Step 2: set the secrets

Each app has its own secrets file in the repository root: `printer1.secrets.env` and `printer-android.secrets.env`. Both are ignored by git (`.gitignore`) and by the Docker build (`.dockerignore`), and they stay on your machine. You can fill them before step 1; only the upload needs the apps.

> These files hold production secrets in plain text. Keep the project folder out of cloud sync (e.g. iCloud "Desktop & Documents"), and `chmod 600` the files.

### 2.1 Fill the files
Each file has four lines. Replace every `REPLACE_ME`:

| Name | Where to get it |
|---|---|
| `API_KEY` | Make it yourself: `openssl rand -hex 24` (48 characters `0-9a-f`). Run it twice: **one key per app**. The mobile app sends it as `X-API-Key`. Fly never shows it back, so save both in the password manager right away. |
| `UPSTASH_REDIS_REST_URL` | This app's Upstash database (`printer1-converter-ratelimit` or `printer-android-converter-ratelimit`), **REST API** section. The full URL, with `https://`. |
| `UPSTASH_REDIS_REST_TOKEN` | Same place. The standard token, **not** the read-only one. A read-only token is easy to miss: the server starts, but every `/convert` answers `503` and `fly logs` says `Rate limit check failed`. |
| `CLOUDCONVERT_API_KEY` | This app's CloudConvert key, or the temporary one (step 0). CloudConvert shows a key only once, when you create it. No key at all: delete the line, and the server uses LibreOffice only. |

Format: `NAME=value`, no spaces around `=`, no quotes, the whole value on one line, no `#` in a value (Fly cuts everything after ` #`). Keep the names as they are and add no others (no `CLOUDCONVERT_SANDBOX`, no `PORT`).

If the files are missing (for example after a fresh clone), create them with these four lines.

### 2.2 Check the files

```bash
grep -n REPLACE_ME printer1.secrets.env printer-android.secrets.env   # must print nothing
```

If it prints something, each line shows `file:line:` where a value is still missing.

### 2.3 Upload (after step 1)

```bash
fly secrets import --stage -a printer1-converter-production < printer1.secrets.env
fly secrets import --stage -a printer-android-converter-production < printer-android.secrets.env
fly secrets list -a printer1-converter-production          # 4 names, no values
fly secrets list -a printer-android-converter-production   # 4 names, no values
```

- `< file` hands the file to the command, so the values stay out of your shell history and off the screen.
- `--stage` stores them without applying them. There are no Machines yet; the first deploy (step 3) picks them up.

How `fly secrets import` reads the file: one `NAME=VALUE` per line, lines starting with `#` and empty lines are skipped, quotes around a value are removed, and ` # text` after a value is cut off.

### 2.4 Fix a mistake
Edit the file and run the same `import` again; the new value replaces the old one. Before the first deploy keep `--stage`. After it, leave `--stage` out: Fly then restarts the Machines with the new value.

## Step 3: first deploy by hand (iOS first)

```bash
fly deploy --config fly.printer1.toml
```

Check it (step 4). If it works, deploy Android and check it the same way:

```bash
fly deploy --config fly.printer-android.toml
```

- The image is built on Fly's servers; no local Docker needed. The first build takes several minutes (LibreOffice and fonts).
- Fly creates **2 Machines** per app on the first deploy. Do **not** add `--ha=false`.
- One Machine always runs (`min_machines_running = 1`); the other is a **stopped spare** (`auto_stop_machines = "stop"`). Fly starts the spare when the first one is busy (over `soft_limit`), down, or being deployed, and stops it again when traffic is low. A stopped Machine costs only its disk, so the price is close to one Machine (~$15/month per app in Frankfurt).
- Each Machine: 2 GB RAM, 2 shared CPUs, HTTPS forced, `/health` checked every 30 s.
- More traffic later: `fly scale count 3 -a <app>` adds another spare. Signs you need it: many `503 Server busy` in `fly logs`, the spare almost never stops, memory close to 2 GB.
- If the server cannot start (for example a wrong Redis token), the health check fails and `fly logs -a <app>` shows why.

> On Fly, `/tmp` is on disk, not in RAM (the README's `--tmpfs` is only for plain Docker).

## Step 4: check it works
For each app:

```bash
fly logs -a printer1-converter-production      # "Converter listening on :3000"
curl https://printer1-converter-production.fly.dev/health
# expect: {"ok":true}

# Any small .docx. The key is read from the secrets file, so it stays out of your shell history.
curl -D - -H "X-API-Key: $(grep '^API_KEY=' printer1.secrets.env | cut -d= -f2-)" \
  -H "X-Device-ID: check-device-0000000001" \
  -F file=@report.docx https://printer1-converter-production.fly.dev/convert -o report.pdf
# expect: 200, X-Converted-By: cloudconvert
# (libreoffice means CloudConvert failed or has no key: fly logs says why)
# 503 "Service temporarily unavailable": wrong Upstash token (read-only?), see step 2.1
```

Also check:
- Printer 1's `API_KEY` gets `401` on the Android URL, and the other way round:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    -H "X-API-Key: $(grep '^API_KEY=' printer1.secrets.env | cut -d= -f2-)" \
    https://printer-android-converter-production.fly.dev/convert     # expect 401
  ```
- A big file (tens of MB) converts without the connection being cut.
- Upstash **Data Browser** shows keys like `rl:<device-id>:m:...`.
- `fly scale show -a <app>` shows 2 GB.
- `fly status -a <app>` shows 2 Machines: one `started`, one `stopped` (after a few quiet minutes). Seen on the first deploy: after ~5 quiet minutes Fly stopped the spare, and the server exited cleanly (`SIGINT`, `All requests finished, exiting`, code 0). Not seen yet: the spare starting while the other Machine is replaced on a deploy; watch `fly status` during the next one.
- If `curl` says `Could not resolve host` right after the first deploy while `dig <app>.fly.dev` works, your Mac cached the name before it existed. Run `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, or add `--resolve <app>.fly.dev:443:<Shared ipv4 from the deploy output>` to `curl`.

## Step 5: set each app's own CloudConvert key (done 2026-11-26)
Also use this to change the key later. The account's **email must be verified**: otherwise CloudConvert answers `403 Your email address is not verified` to every job, and all conversions fall back to LibreOffice.

Put this app's key in the `CLOUDCONVERT_API_KEY` line of `printer1.secrets.env` and upload the whole file again:

```bash
fly secrets import -a printer1-converter-production < printer1.secrets.env
```

No `--stage` here: Fly restarts the Machines with the new key (conversions in progress finish first). Check that `/convert` answers with `X-Converted-By: cloudconvert`, and that `fly logs` has no `CloudConvert failed ... HTTP 401` (wrong key) or `HTTP 403` (a missing scope). Same for Android with its own key. The test job does not stay in CloudConvert's **Jobs** list (the server deletes it right away); to see which account was used, check that its credits went down. Then revoke any temporary key. If it is the same key as in your local `.env`, give local development a new key first.

## Step 6: let GitHub deploy both (the release matrix)
The workflow is `.github/workflows/deploy.yml`. It runs the tests, then deploys the same revision to both apps, one job per app. It starts only by hand (**Actions → Deploy → Run workflow**) or when you push a tag such as `v1.0.0`. It does **not** deploy on every push.

```bash
fly tokens create deploy -a printer1-converter-production
fly tokens create deploy -a printer-android-converter-production
```

In GitHub: **Settings → Environments**. Create `printer1` and `printer-android`, and in each add a secret `FLY_API_TOKEN` with that app's token. Each token works for one app only, so a mistake in one product cannot touch the other. Optionally add required reviewers.

> Environments in a **private** repository need a paid GitHub plan (Pro, Team or Enterprise). Without it, move the repository to the company organization, or use two repository secrets and change the workflow.

Run the workflow once by hand to check it.

## Step 7: set each mobile app
Each app gets **its own** URL and `API_KEY` (send them through a password manager):

```swift
let service = ConverterService(baseURL: URL(string: "https://printer1-converter-production.fly.dev")!, apiKey: <key from config>)
```

- Do not write the key in committed code. Load it from a build setting, a config file that is not committed, or remote config.
- Use only this URL for the whole conversion. Do not fall back to the other product's server.
- **Before the store release**, decide the final URL: a URL compiled into a released app changes only with an app update. For your own domain:
  ```bash
  fly certs add converter.example.com -a printer1-converter-production
  ```
  Add the DNS record it prints (a CNAME to `<app>.fly.dev`) and wait until `fly certs show converter.example.com -a printer1-converter-production` says it is ready. The `.fly.dev` URL keeps working too.

## How deploys stop the old server
On every deploy or restart Fly sends `SIGINT`, waits `kill_timeout` (240 s in `fly.*.toml`), then kills the process. The server (`src/server.js`) stops taking new requests at once, finishes the conversions in progress, and exits. Fly replaces the Machines one by one; while the running one is replaced, Fly starts the spare, so the service should stay up (a few seconds of start-up at most).

`[http_service.http_options] idle_timeout = 300` lets a conversion stay quiet for up to ~105 s (CloudConvert, then LibreOffice) before the first byte of the answer.

## Change a secret

```bash
fly secrets import -a printer1-converter-production < printer1.secrets.env   # after editing the file; restarts the Machines
```

For Upstash: reset the token in the database settings first. For CloudConvert: create a new key, set it, then delete the old one.

## Isolation checklist
- [ ] Two Fly apps, two URLs
- [ ] Different `API_KEY` for each
- [ ] Different Upstash database for each
- [ ] Different CloudConvert key for each
- [ ] Different `FLY_API_TOKEN` per GitHub environment
- [ ] Each mobile app points only to its own URL
- [ ] Printer 1's key gives `401` on the Android URL, and the other way round

## Roll back
```bash
fly releases -a printer1-converter-production
fly deploy --config fly.printer1.toml --image registry.fly.io/printer1-converter-production:<older-tag>
```

## Still to do (not covered here)
- LibreOffice is only half isolated (see `KNOWN_PROBLEMS.md`).
- LibreOffice on Fly: emoji come out invisible and UTF-8 `.csv` with non-Latin text is garbled (see `KNOWN_PROBLEMS.md`).
- Watch memory in Fly's metrics for the first weeks.
- DPA with CloudConvert and Upstash (see `LEGAL_NOTES.md`).
