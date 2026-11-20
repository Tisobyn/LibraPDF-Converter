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
app.listen(PORT, () => console.log(`Converter listening on :${PORT}`));
