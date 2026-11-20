import Foundation

enum ConverterError: LocalizedError {
    case tooLarge, unsupported, cannotConvert, busy(retryAfter: Int), timeout, server(String)

    var errorDescription: String? {
        switch self {
        case .tooLarge: return "File too large (max 50 MB). Make the images smaller or save it as PDF first."
        case .unsupported: return "Format not supported"
        case .cannotConvert: return "Can't convert this file"
        case .busy(let seconds): return "Server busy, try again in \(seconds) seconds"
        case .timeout: return "Took too long, try again"
        case .server(let m): return m
        }
    }
}

struct ConverterService {
    // Simulator: http://localhost:3000 — real iPhone: your Mac's IP or the deployed HTTPS server.
    let baseURL: URL
    // Do not commit a real key. Load it from config / Keychain.
    let apiKey: String

    /// Sends a document to the server and returns the URL of the saved PDF (temp folder).
    /// If the server is busy (503), waits for `Retry-After` seconds and tries again (up to `retries` times).
    func convertToPDF(fileURL: URL, retries: Int = 2) async throws -> URL {
        // Already a PDF: nothing to convert, and no size limit.
        if fileURL.pathExtension.lowercased() == "pdf" {
            // Copy it to the temp folder: access to the picked file ends when we return.
            let access = fileURL.startAccessingSecurityScopedResource()
            defer { if access { fileURL.stopAccessingSecurityScopedResource() } }
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(fileURL.lastPathComponent)
            try? FileManager.default.removeItem(at: copy)
            try FileManager.default.copyItem(at: fileURL, to: copy)
            return copy
        }
        var attemptsLeft = retries
        while true {
            do {
                return try await convertOnce(fileURL: fileURL)
            } catch ConverterError.busy(let seconds) where attemptsLeft > 0 {
                attemptsLeft -= 1
                try await Task.sleep(nanoseconds: UInt64(max(seconds, 1)) * 1_000_000_000)
            }
        }
    }

    private func convertOnce(fileURL: URL) async throws -> URL {
        // File from .fileImporter needs security-scoped access.
        let access = fileURL.startAccessingSecurityScopedResource()
        defer { if access { fileURL.stopAccessingSecurityScopedResource() } }

        let fileData = try Data(contentsOf: fileURL)

        // Build multipart/form-data body with one field named "file".
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileURL.lastPathComponent)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var request = URLRequest(url: baseURL.appendingPathComponent("convert"))
        request.httpMethod = "POST"
        request.timeoutInterval = 240 // must be longer than the server worst case (CLOUDCONVERT_TIMEOUT_MS + CONVERT_TIMEOUT_MS)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-API-Key")

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.upload(for: request, from: body)
        } catch let error as URLError where error.code == .timedOut {
            throw ConverterError.timeout
        }

        guard let http = response as? HTTPURLResponse else { throw ConverterError.server("No response") }
        switch http.statusCode {
        case 200: break
        case 413: throw ConverterError.tooLarge
        case 415: throw ConverterError.unsupported
        case 422: throw ConverterError.cannotConvert
        case 503:
            let seconds = Int(http.value(forHTTPHeaderField: "Retry-After") ?? "") ?? 5
            throw ConverterError.busy(retryAfter: seconds)
        case 504: throw ConverterError.timeout
        default:
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ConverterError.server(message ?? "Error \(http.statusCode)")
        }

        let pdfName = fileURL.deletingPathExtension().lastPathComponent + ".pdf"
        let outURL = FileManager.default.temporaryDirectory.appendingPathComponent(pdfName)
        try data.write(to: outURL, options: .atomic)
        return outURL
    }
}
