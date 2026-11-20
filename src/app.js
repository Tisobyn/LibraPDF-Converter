import express from "express";
import multer from "multer";
import { rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { convertToPdf, SUPPORTED_EXTENSIONS } from "./convert.js";

function keyMatches(given, expected) {
  const a = Buffer.from(given || ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({
  apiKey = process.env.API_KEY,
  maxMb = Number(process.env.MAX_FILE_MB || 50),
  maxUploads = Number(process.env.MAX_UPLOADS || 10),
  maxUploadMb = Number(process.env.MAX_UPLOAD_MB_TOTAL || 500),
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("API_KEY is missing or empty. Set a long secret before starting the server.");
  }
  let activeRequests = 0;
  let reservedBytes = 0; // total size of files being handled right now
  const upload = multer({
    dest: path.join(process.env.TMPDIR || "/tmp", "uploads"),
    limits: { fileSize: maxMb * 1024 * 1024, files: 1 },
  });
  const app = express();

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/formats", (_req, res) => res.json({ extensions: [...SUPPORTED_EXTENSIONS] }));

  app.post("/convert", (req, res, next) => {
    if (!keyMatches(req.get("x-api-key"), apiKey)) return res.status(401).json({ error: "Unauthorized" });
    // Size the client says it will send. If missing, assume the biggest allowed file.
    const maxBytes = maxMb * 1024 * 1024;
    const declared = Number(req.get("content-length"));
    const size = Number.isFinite(declared) && declared > 0 ? declared : maxBytes;
    if (size > maxBytes + 1024 * 1024) return res.status(413).json({ error: "File too large" }); // +1 MB for form overhead
    // Server full (too many requests, or too many megabytes): say so before any file is stored.
    const full = activeRequests >= maxUploads || (activeRequests > 0 && reservedBytes + size > maxUploadMb * 1024 * 1024);
    if (full) return res.set("Retry-After", "5").status(503).json({ error: "Server busy, retry shortly" });
    activeRequests++;
    reservedBytes += size;
    res.on("close", () => { activeRequests--; reservedBytes -= size; });
    next();
  }, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Send a multipart field named 'file'" });
    try {
      const { pdf, engine } = await convertToPdf(req.file.path, req.file.originalname);
      const base = path.basename(req.file.originalname, path.extname(req.file.originalname)) || "document";
      res.set({
        "X-Converted-By": engine,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(base)}.pdf`,
      }).send(pdf);
    } catch (err) {
      if (err.status === 503) res.set("Retry-After", "5");
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      await rm(req.file.path, { force: true });
    }
  });

  app.use((err, _req, res, _next) => {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : err.status || 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}
