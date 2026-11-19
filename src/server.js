import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 3000);
let app;
try {
  app = createApp();
} catch (err) {
  console.error(`Cannot start: ${err.message}`);
  process.exit(1);
}
app.listen(PORT, () => console.log(`Converter listening on :${PORT}`));
