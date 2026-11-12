#!/usr/bin/env node
/**
 * CLI: node generate.mjs <output.pdf> [--dry-run]
 * Reads JSON { form, analysis } from stdin.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildProposalContent } from "./proposalContent.js";
import { buildProposalPdf } from "./buildProposalPdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, "assets");
const FONTS = path.join(ASSETS, "fonts");

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) fail("No JSON payload on stdin");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON on stdin: ${e.message}`);
  }
}

function loadFonts() {
  const required = {
    leagueSpartanBold: path.join(FONTS, "LeagueSpartan-Bold.ttf"),
    poppinsRegular: path.join(FONTS, "Poppins-Regular.ttf"),
    poppinsSemiBold: path.join(FONTS, "Poppins-SemiBold.ttf"),
    ralewayMedium: path.join(FONTS, "Raleway-Medium.ttf"),
  };
  const fonts = {};
  for (const [key, file] of Object.entries(required)) {
    if (!fs.existsSync(file)) fail(`Missing font: ${file}`);
    fonts[key] = fs.readFileSync(file);
  }
  return fonts;
}

async function main() {
  const outArg = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!outArg && !dryRun) fail("Usage: node generate.mjs <output.pdf> [--dry-run]");

  const payload = await readStdin();
  const form = payload.form || {};
  const analysis = payload.analysis || {};
  const content = buildProposalContent({ form, analysis });

  if (dryRun) {
    process.stdout.write(JSON.stringify({ form, analysis, content }, null, 2) + "\n");
    return;
  }

  const templatePath = path.join(ASSETS, "template.pdf");
  if (!fs.existsSync(templatePath)) fail(`Missing template: ${templatePath}`);
  const templateBytes = fs.readFileSync(templatePath);
  const fonts = loadFonts();

  let pdfBytes;
  try {
    pdfBytes = await buildProposalPdf({ form, analysis, content, templateBytes, fonts });
  } catch (e) {
    fail(`PDF build failed: ${e.message || e}`);
  }

  const outPath = path.resolve(outArg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`Wrote ${outPath} (${pdfBytes.length} bytes)`);
}

main().catch((e) => fail(String(e?.stack || e)));
