# How to connect from iOS and Android

The API is the same for both. Examples below are Swift; on Android use OkHttp / Retrofit with the same request.

## What this does
You send a document to the server. The server sends back a PDF.

## The one request you need
- **POST** `{BASE_URL}/convert`
- Body: `multipart/form-data` with one field named **`file`**
- Header: `X-API-Key: <key>` (always required; the server will not start without an `API_KEY`)
- Header: `X-Device-ID: <random id>` (always required; 16–64 letters, digits or dashes). The app makes it once per install. `ConverterService` does this for you. The server counts requests per ID.
- Success: status **200**, body is the PDF bytes
- Header `X-Converted-By` in the response: always `libreoffice` (for debugging, the app can ignore it)

## Steps
1. Get the file URL (e.g. from `.fileImporter`).
2. Call `url.startAccessingSecurityScopedResource()` before reading it. Call `stop...` after.
3. Send it with `URLSession.shared.upload(for:from:)`.
4. Save the returned bytes to a `.pdf` file in the temp folder.
5. Give that file URL to your print / preview code.

## Status codes
| Code | Meaning | What to show the user |
|---|---|---|
| 200 | Done | PDF |
| 400 | No file sent | Bug in your code |
| 401 | Wrong API key | Bug / config |
| 400 | No file sent, or missing/invalid `X-Device-ID` | Bug in your code |
| 413 | File over 50 MB | "File too large (max 50 MB). Make the images smaller or save it as PDF first." |
| 415 | Unsupported or fake file type | "Format not supported" |
| 422 | Conversion failed (broken or password-protected file) | "Can't convert this file" |
| 429 | Too many requests from this device (10 per minute, 500 per day). Has a `Retry-After` header | "Too many files in a short time. Try again in N seconds." Do not retry by yourself |
| 503 | Server busy (too many uploads). Has a `Retry-After` header | `ConverterService` waits that many seconds and retries 2 times by itself. If it still fails, show "Server busy, try again" |
| 504 | Took too long | "Try again" |

Errors come as JSON: `{"error": "message"}`.

## Other endpoints
- `GET /formats` → list of supported file extensions
- `GET /health` → `{"ok": true}`

## Testing
- **Simulator:** `http://localhost:3000`. Add `NSAllowsLocalNetworking = YES` in Info.plist (App Transport Security).
- **Real iPhone:** `localhost` does not work. Use your Mac's IP (same Wi-Fi) or the deployed server.
- **Two products:** each product's app uses **only its own** server hostname and `API_KEY` for the whole conversion (upload and PDF). Never fall back to the other product's server. See [DEPLOY_FLY.md](DEPLOY_FLY.md).
- **Production:** must be **HTTPS**.
- Run the server: `API_KEY=change-me npm start` in the converter folder (or `npm run start:env` with a `.env` file). Needs LibreOffice installed.

## Rules
- Set the request timeout to ~240 seconds. Normal: 5–30 seconds. Worst case: about 60 seconds with the default server timeout.
- The app timeout must always be longer than `CONVERT_TIMEOUT_MS` on the server. If you raise it, raise this too.
- Show a loading spinner.
- Do not hardcode the API key in committed code.
- Check the extension on the phone before uploading. Saves a round trip.
- PDF files are not sent to the server. `ConverterService` copies them to the temp folder and returns that copy.

## Full code example
Copy [ConverterService.swift](ConverterService.swift) into your Xcode project (async/await, about 70 lines).

```swift
// baseURL: your server. apiKey: the server's API_KEY from .env.
let service = ConverterService(baseURL: URL(string: "http://localhost:3000")!, apiKey: "change-me")

// pickedURL: the file URL the user chose, e.g. from .fileImporter
let pdfURL = try await service.convertToPDF(fileURL: pickedURL)
// give pdfURL to your preview / print code
```

Example with `.fileImporter` in SwiftUI:

```swift
.fileImporter(isPresented: $showPicker, allowedContentTypes: [.item]) { result in
    guard case .success(let pickedURL) = result else { return }
    Task {
        do { pdfURL = try await service.convertToPDF(fileURL: pickedURL) }
        catch { errorText = error.localizedDescription }
    }
}
```
