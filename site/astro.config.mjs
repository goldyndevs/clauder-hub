// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static build served at the root of https://clauder-hub.sitenow.cloud.
export default defineConfig({
  site: "https://clauder-hub.sitenow.cloud",
  output: "static",
  vite: { plugins: [tailwindcss()] },
});
