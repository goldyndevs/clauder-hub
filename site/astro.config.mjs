// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Static build for GitHub Pages: https://goldyndevs.github.io/clauder-hub
export default defineConfig({
  site: "https://goldyndevs.github.io",
  base: "/clauder-hub",
  output: "static",
  vite: { plugins: [tailwindcss()] },
});
