# Deploy to Fly.io: two separate apps (Printer 1 and Printer Android)

> **Status: prepared, not tested.** There is no Fly account yet, so nobody has deployed with these files.
> Names and domains in them are placeholders. Check every step on the first real deploy.

## The idea
- Two Fly apps from **one repository and one Dockerfile**: one for Printer 1, one for Printer Android.
- Each app has **its own** secrets, Redis database and hostname.
- One GitHub workflow deploys the **same revision** to both apps.
- Each mobile app uses **only its own hostname**, from upload to PDF.

| | Printer 1 | Printer Android |
|---|---|---|
| Fly app (placeholder) | `printer1-converter` | `printer-android-converter` |
| Config file | `fly.printer1.toml` | `fly.printer-android.toml` |
| Hostname (placeholder) | `converter.printer1.example.com` | `converter.printer-android.example.com` |
| `API_KEY` | its own | its own |
| Upstash Redis database | its own | its own |
| GitHub environment + `FLY_API_TOKEN` | `printer1` | `printer-android` |

## Step 0: get access (only people can do this)
1. Ask Somalic in `#devops_intake` for a dedicated Fly.io organization for your team.
2. Install the Fly CLI (`brew install flyctl`) and log in: `fly auth login`.
3. For questions about one workflow for both apps and separate secrets, ask Shputya.

## Step 1: create the two apps
Use the real names (and put the same names in the `app = "..."` line of each `fly.*.toml` file):

```bash
fly apps create printer1-converter --org YOUR-ORG
fly apps create printer-android-converter --org YOUR-ORG
```

## Step 2: make a secrets file for each product
Make one Upstash Redis database per product (Frankfurt, free plan).

Create a file `printer1.secrets.env` **outside the repository** (or in the repo; `*.secrets.env` is in `.gitignore`):

```
API_KEY=<a long random string>
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=...
```

Make the `API_KEY` with `openssl rand -hex 24`. **Use a different one for each product.**

Send it to Fly, then delete the file:

```bash
fly secrets import -a printer1-converter < printer1.secrets.env
rm printer1.secrets.env
```

Do the same for `printer-android-converter` with its own file. (Using `import` keeps the secrets out of your shell history.)

## Step 3: first deploy by hand

```bash
fly deploy --config fly.printer1.toml
fly deploy --config fly.printer-android.toml
```

Each config asks for 2 GB RAM and 2 CPU, forces HTTPS, and checks `/health`.

> On Fly, `/tmp` is on disk, not in RAM (the README's `--tmpfs` is only for plain Docker). So the memory budget is less tight here. Keep the limits anyway.

## Step 4: give each app its own hostname

```bash
fly certs add converter.printer1.example.com -a printer1-converter
fly certs add converter.printer-android.example.com -a printer-android-converter
```

Then add the DNS records that the command prints (usually a CNAME). Check with `fly certs show <hostname> -a <app>` until the certificate is ready.

## Step 5: let GitHub deploy both (the release matrix)
The workflow is `.github/workflows/deploy.yml`. It runs the tests, then deploys the same revision to both apps, one job per product. It starts only by hand (**Actions → Deploy → Run workflow**) or when you push a tag such as `v1.0.0`. It does **not** deploy on every push.

In GitHub: **Settings → Environments**. Create two environments, `printer1` and `printer-android`. In each one add a secret named `FLY_API_TOKEN`, made for that app only:

```bash
fly tokens create deploy -a printer1-converter
fly tokens create deploy -a printer-android-converter
```

Each token works for one app only, so a mistake in one product cannot touch the other. Optionally add required reviewers on each environment.

## Step 6: check it works
For each product:

```bash
curl https://converter.printer1.example.com/health
# expect: {"ok":true}

curl -D - -H "X-API-Key: <that product's API_KEY>" -H "X-Device-ID: check-device-0000000001" \
  -F file=@report.docx https://converter.printer1.example.com/convert -o report.pdf
# expect: 200, X-Converted-By: libreoffice
```

Also check that Printer 1's `API_KEY` does **not** work on the Printer Android hostname (you should get `401`).

## Step 7: set each mobile app
Each product's app creates `ConverterService` with **its own** hostname and key:

```swift
let service = ConverterService(baseURL: URL(string: "https://converter.printer1.example.com")!, apiKey: <key from config>)
```

- Do not write the key in committed code. Load it from a build setting, a config file that is not committed, or the server's remote config.
- Use only this hostname for the whole conversion (upload and download). Do not fall back to the other product's server.

## Isolation checklist
- [ ] Two Fly apps, two hostnames
- [ ] Different `API_KEY` for each
- [ ] Different Upstash database for each
- [ ] Different `FLY_API_TOKEN` per GitHub environment
- [ ] Each mobile app points only to its own hostname
- [ ] Printer 1's key gives `401` on the Android hostname, and the other way round

## Roll back
```bash
fly releases -a printer1-converter
fly deploy --config fly.printer1.toml --image registry.fly.io/printer1-converter:<older-tag>
```

## Still to do (not covered here)
- Fly checks are not tested yet. Test the first deploy on a staging app if you can.
- LibreOffice is only half isolated (see `KNOWN_PROBLEMS.md`).
- The Docker image has not been built yet (Docker is not installed on the dev Mac).
