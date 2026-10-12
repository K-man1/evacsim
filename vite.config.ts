import { defineConfig } from "vite";

export default defineConfig({
  // The worker imports the sim as modules; the default classic-script format can't.
  worker: { format: "es" },
  build: { target: "es2023" },
});
