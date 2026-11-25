import { createApp } from "./app.js";
import { createRateLimiterFromEnv } from "./ratelimit.js";

const PORT = Number(process.env.PORT || 3000);
let app, rateLimiter;
try {
  rateLimiter = createRateLimiterFromEnv();
  app = createApp({ rateLimiter });
  if (rateLimiter) await rateLimiter.ping(); // check Redis address and token before we listen
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}
const server = app.listen(PORT, () => console.log(`Converter listening on :${server.address().port}`));

// Graceful stop. Fly.io sends SIGINT on every deploy or restart, waits kill_timeout (fly.*.toml),
// then kills. Stop taking new requests, let the ones in progress finish, then exit.
// A second signal (e.g. Ctrl+C twice) exits at once.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`${signal}: not taking new requests, finishing the ones in progress`);
    server.close(() => {
      console.log("All requests finished, exiting");
      process.exit(0);
    });
    // Keep-alive connections stay open after their last response; close each one as soon as it is idle.
    setInterval(() => server.closeIdleConnections(), 500).unref();
  });
}
