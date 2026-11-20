# How it works

> **PDF version (4 pages, easy to share):** [AirPrinter-Converter-Diagrams.pdf](AirPrinter-Converter-Diagrams.pdf)
> Pages: 1. Overview, 2. Request sequence, 3. Scaling, 4. Where user data goes. Sources: [diagrams/](diagrams/).

## In one picture

```mermaid
flowchart TD
    A["iOS / Android app<br/>sends a document"] --> B["POST /convert"]
    B --> C{"API key OK?<br/>free slot?<br/>under the<br/>rate limit?<br/>file size OK?"}
    C -- no --> E1["401 / 503 / 429 / 413 error"]
    C -- yes --> D{"Type allowed AND<br/>content matches extension?"}
    D -- no --> E2["415 error"]
    D -- yes --> F{"CloudConvert<br/>key set?"}
    F -- yes --> G["CloudConvert<br/>(max 45 s)"]
    G -- success --> H["PDF"]
    G -- "fails / timeout" --> I
    F -- no --> I["Our LibreOffice<br/>(max 60 s)"]
    I -- success --> H
    I -- "LibreOffice full" --> E3["503 busy, app retries"]
    I -- "broken file / timeout" --> E4["422 / 504 error"]
    H --> J["Delete temp files<br/>(also at CloudConvert, retried)"]
    J --> K["200 + PDF<br/>header X-Converted-By"]
    K --> L["App shows the PDF"]
```

## Step by step (happy path)

```mermaid
sequenceDiagram
    participant App as App
    participant API as Our server
    participant CC as CloudConvert
    participant LO as LibreOffice

    App->>API: POST /convert (file)
    API->>API: check key, free slot, rate limit (Redis), size, type, content
    API->>CC: upload file, convert to PDF
    alt CloudConvert works
        CC-->>API: PDF
        API->>CC: delete job (retry if it fails)
    else CloudConvert fails or is slow
        API->>LO: convert locally
        LO-->>API: PDF
    end
    API->>API: delete temp files
    API-->>App: 200 + PDF (X-Converted-By)
```

## Two products, two separate servers

Printer 1 and Printer Android must not share a public conversion API. We keep **one repository** and deploy the **same revision** to **two Fly.io apps**. Each has its own hostname, `API_KEY`, Upstash Redis database and CloudConvert key. Steps: [DEPLOY_FLY.md](DEPLOY_FLY.md) (prepared, not tested yet).

```mermaid
flowchart LR
    REPO["One repository<br/>one revision"] --> CI["GitHub Actions<br/>release matrix"]
    CI --> F1["Fly app: Printer 1<br/>own hostname, key,<br/>Redis, CloudConvert key"]
    CI --> F2["Fly app: Printer Android<br/>own hostname, key,<br/>Redis, CloudConvert key"]
    P1["Printer 1 app"] -- "its own hostname only" --> F1
    P2["Printer Android app"] -- "its own hostname only" --> F2
```

## Who does what

| Part | Job |
|---|---|
| App (iOS / Android) | Picks the file, uploads it, shows the PDF or the error. Retries after 503. Does not send PDF files |
| Our server (Node + Express) | Checks the file, picks the engine, returns the PDF |
| Upstash Redis | Counts requests per device for the rate limit. Shared by all server copies |
| CloudConvert | **First engine.** Converts online. Costs money per file |
| LibreOffice | **Backup engine.** Runs on our server. Free, but uses our CPU and RAM |

## Limits (all can be changed)

| Limit | Value | Setting |
|---|---|---|
| File size | 50 MB | `MAX_FILE_MB` |
| Requests at the same time | 10 | `MAX_UPLOADS` |
| Total size of files at the same time | 500 MB | `MAX_UPLOAD_MB_TOTAL` |
| LibreOffice jobs at the same time | 2 | `MAX_CONCURRENT` |
| Requests per device per minute | 10 | `RATE_LIMIT_PER_MINUTE` |
| Requests per device per day | 500 | `RATE_LIMIT_PER_DAY` |
| Over a size / count limit | `503` + `Retry-After` | |
| Over a rate limit | `429` + `Retry-After` | |

## Why two engines
- CloudConvert is the main one: good quality, and our server stays free.
- LibreOffice is the safety net: if CloudConvert is down, out of credits or slow, users still get a PDF.

## Where the file goes
1. Phone → our server (HTTPS)
2. Our server → CloudConvert (HTTPS)
3. CloudConvert → our server (PDF)
4. Our server → phone (PDF)

Our server and CloudConvert both delete the file right after. If the CloudConvert delete fails, we retry. CloudConvert removes it itself after 24 hours.
