import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { NextConfig } from "next";

/**
 * The browser's PDF viewer needs pdf.js's worker, character maps and standard
 * fonts served as static files, from exactly the pdf.js version the server
 * extracts text with. They are copied from node_modules into public/pdfjs
 * whenever the app starts or builds (dev, build and start all load this file),
 * and skipped when the copy is already that version.
 */
function copyPdfAssets() {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const out = path.join(process.cwd(), "public", "pdfjs");
  const marker = path.join(out, ".version");
  if (existsSync(marker) && readFileSync(marker, "utf8") === version) return;

  mkdirSync(out, { recursive: true });
  cpSync(path.join(root, "build", "pdf.worker.min.mjs"), path.join(out, "pdf.worker.min.mjs"));
  for (const dir of ["cmaps", "standard_fonts"]) {
    cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
  }
  writeFileSync(marker, version);
}
copyPdfAssets();

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Loaded with Node's own require on the server: pdf.js reads its worker, fonts and
  // character maps from disk, and these packages are not written for bundling.
  serverExternalPackages: ["pdfjs-dist", "mammoth", "linkedom"],
  // Files the server reads from disk at run time, which import tracing can't see: the database
  // migrations and pdf.js's worker, character maps and fonts. Hosts that deploy only traced files need this.
  outputFileTracingIncludes: {
    "/**": [
      "./drizzle/**/*",
      "./node_modules/pdfjs-dist/legacy/build/**/*",
      "./node_modules/pdfjs-dist/cmaps/**/*",
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
