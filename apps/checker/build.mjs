// Builds two outputs:
//  dist/index.html    — full standalone page for hosting (Cloudflare Pages, Netlify, S3…)
//                       with a CSP that forbids ALL network calls from script (AT-18).
//  dist/artifact.html — the same page body, for previewing as a claude.ai artifact.
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const INSTALL_URL = process.env.INSTALL_URL ?? "https://apps.shopify.com/";

const out = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  write: false,
  define: { __INSTALL_URL__: JSON.stringify(INSTALL_URL) },
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const body = await readFile("src/page.html", "utf8");
const fragment = `${body}\n<script>${js}</script>\n`;

// connect-src 'none' makes it technically impossible for the page to send the file anywhere.
const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const full = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="robots" content="index,follow">
</head>
<body>
${fragment}
</body>
</html>
`;

await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", full);
await writeFile("dist/artifact.html", fragment);
console.log(`built dist/index.html (${(full.length / 1024).toFixed(1)} KB)`);
