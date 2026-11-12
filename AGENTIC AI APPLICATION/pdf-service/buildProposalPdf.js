/**
 * Overlay dynamic proposal text onto the 3-page WebWorks Co. template.pdf.
 *
 * Template pages: 0=cover, 1=body (duplicated for overflow), 2=contact/back.
 *
 * API: buildProposalPdf({ form, analysis, content, templateBytes, fonts }) -> Uint8Array
 *
 * Role → Font → Usage (strict spec — do not add a fifth font):
 * | Role      | Font                | Used for                                  | Existing constant |
 * |-----------|---------------------|--------------------------------------------|--------------------|
 * | Primary   | League Spartan Bold | ALL headings (every `heading()` call)      | H                  |
 * | Secondary | Poppins Regular     | Body text & bullet text                    | P                  |
 * | Emphasis  | Poppins SemiBold    | Pain-point / strength titles, bullet dots  | PB                 |
 * | Accent    | Raleway Medium      | Subtitle only (CTA/eyebrow removed)        | R                  |
 *
 * Sizes (do not override without a comment): title 21pt, subtitle 12pt,
 * headings 13pt, body/bullets 10pt. PB titles use 15 lineHeight;
 * body/bullets use 10pt at 1.6 line-height. Cover client name is fixed 36pt.
 */
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const PAGE_W = 595.5;
const PAGE_H = 842.25;

// Body content band (A4, origin bottom-left)
const BODY = {
  left: 48,
  right: 547,
  top: 760,
  bottom: 88,
  lineGap: 4,
};

const SIZE = {
  title: 21, // c.title — League Spartan Bold (H)
  subtitle: 12, // c.subtitle — Raleway Medium (R)
  heading: 13, // heading() — League Spartan Bold (H)
  body: 10, // paragraph / bullet body — Poppins Regular (P)
};

const LINE = {
  body: SIZE.body * 1.6, // 16 — default body / bullet text
  title: 15, // PB pain-point / strength titles
};

const BULLET_MARK = "•";

// Cover client-name band (sampled from template.pdf page 1 dark strip)
// RGB(18,19,21) at pdf (~400,266) via PyMuPDF 2x render.
const COVER_BAND_BG = rgb(0.071, 0.075, 0.082);
const COVER_X = 344.9; // just after the band X / divider (matches baked "EVO Vending" start)
const COVER_BASELINE = 266.4;
const COVER_SIZE = 36; // fixed — never shrink
const COVER_LEADING = COVER_SIZE * 1.2;
const COVER_COLOR = rgb(1, 1, 1);

// Cover bottom-left placeholder logo (EVO + Vending) — sampled surround, NOT COVER_BAND_BG
// White glyph bbox ~ pdf (40,33.8)-(202,84.2); pad a few pts for anti-alias.
const COVER_LOGO_BG = rgb(10 / 255, 10 / 255, 11 / 255); // median surround of dark swirl, not COVER_BAND_BG
const COVER_LOGO_BOX = { x: 34, y: 18, width: 178, height: 82 };

// Body page top-left kicker graphic (WebWorks mark image; no "Focus" text in stream).
// PyMuPDF image bbox (35.3, 32.3, 119.3, 75.1) → pdf-lib bottom-left y.
// Surround samples are white — do NOT reuse COVER_BAND_BG.
const BODY_PAGE_BG = rgb(1, 1, 1); // sampled around the top-left mark (majority white)
const BODY_FOCUS_BOX = {
  x: 33,
  y: PAGE_H - 78, // ~764 — image bottom ~767
  width: 90,
  height: 50, // covers image top ~810
};

// Color roles (Phase 6 patch — do not restructure draw helpers for color alone)
const HEADING = rgb(0.06, 0.06, 0.06); // near-black — section headings + bullet dots
const SUBHEADING = rgb(0.42, 0.16, 0.8); // former purple — pain/strength title lines only
const COLORS = {
  ink: rgb(0.1, 0.12, 0.18), // BODY text
  muted: rgb(0.35, 0.38, 0.45),
  accent: rgb(0.05, 0.58, 0.53), // ACCENT — subtitle (unchanged)
  white: rgb(1, 1, 1),
  title: rgb(0.08, 0.1, 0.14), // main title (c.title) — leave on TITLE
};

/**
 * @param {{
 *   form?: object,
 *   analysis?: object,
 *   content: object,
 *   templateBytes: Uint8Array|Buffer,
 *   fonts: {
 *     leagueSpartanBold: Uint8Array|Buffer,
 *     poppinsRegular: Uint8Array|Buffer,
 *     poppinsSemiBold: Uint8Array|Buffer,
 *     ralewayMedium: Uint8Array|Buffer,
 *   }
 * }} args
 */
export async function buildProposalPdf({ content, templateBytes, fonts }) {
  if (!templateBytes) throw new Error("templateBytes required");
  if (!content) throw new Error("content required");
  if (!fonts?.leagueSpartanBold || !fonts?.poppinsRegular || !fonts?.poppinsSemiBold || !fonts?.ralewayMedium) {
    throw new Error("fonts.leagueSpartanBold / poppinsRegular / poppinsSemiBold / ralewayMedium required");
  }

  const template = await PDFDocument.load(templateBytes);
  if (template.getPageCount() < 3) {
    throw new Error(`template.pdf must have at least 3 pages (got ${template.getPageCount()})`);
  }

  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);

  const H = await out.embedFont(fonts.leagueSpartanBold, { subset: true });
  const P = await out.embedFont(fonts.poppinsRegular, { subset: true });
  const PB = await out.embedFont(fonts.poppinsSemiBold, { subset: true });
  const R = await out.embedFont(fonts.ralewayMedium, { subset: true });
  // Cover uses Poppins (P) to match the band's baked typography — not a fifth font
  const fontCover = P;

  const [coverTpl, , backTpl] = await out.copyPages(template, [0, 1, 2]);

  // --- Cover ---
  const cover = coverTpl;
  out.addPage(cover);
  drawCoverCompany(cover, content, fontCover);

  // --- Body pages (paginate) ---
  const blocks = buildBlocks(content);
  const fontBag = { H, P, PB, R, TITLE: COLORS.title, SUBHEADING };
  let page = await newBodyPage(out, template);
  let y = BODY.top;

  for (const block of blocks) {
    const needed = measureBlock(block, fontBag);
    if (y - needed < BODY.bottom) {
      page = await newBodyPage(out, template);
      y = BODY.top;
    }
    y = drawBlock(page, block, y, fontBag);
    y -= 14;
  }

  // --- Back / contact (no CTA overlay) ---
  out.addPage(backTpl);

  const bytes = await out.save();
  return bytes;
}

/** Copy template body page and wipe the baked top-left kicker graphic. */
async function newBodyPage(outDoc, templateDoc) {
  const [body] = await outDoc.copyPages(templateDoc, [1]);
  body.drawRectangle({
    x: BODY_FOCUS_BOX.x,
    y: BODY_FOCUS_BOX.y,
    width: BODY_FOCUS_BOX.width,
    height: BODY_FOCUS_BOX.height,
    color: BODY_PAGE_BG,
  });
  outDoc.addPage(body);
  return body;
}



/** Word-wrap helper (also used by layoutCoverName). */
function wrapToWidth(text, font, size, maxWidth) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
      line = trial;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Layout cover client name at fixed COVER_SIZE (36pt) — never shrink.
 * Returns { size: COVER_SIZE, lines: string[] } (1–2 lines).
 */
function layoutCoverName(company, font) {
  const maxWidth = (PAGE_W - 35.3) - COVER_X;
  const name = String(company || "Prospect").trim() || "Prospect";

  if (font.widthOfTextAtSize(name, COVER_SIZE) <= maxWidth) {
    return { size: COVER_SIZE, lines: [name] };
  }

  let lines = wrapToWidth(name, font, COVER_SIZE, maxWidth);

  if (
    lines.length <= 2
    && lines.every((l) => font.widthOfTextAtSize(l, COVER_SIZE) <= maxWidth)
  ) {
    return { size: COVER_SIZE, lines };
  }

  // More than 2 wrap lines (or a line still overflows): keep line 1, put the
  // remainder on line 2 and character-trim until it fits — still COVER_SIZE.
  const line1 = lines[0];
  let line2 = lines.length > 1 ? lines.slice(1).join(" ") : "";
  if (!line2 && name.length > line1.length) {
    line2 = name.slice(line1.length).trim();
  }
  while (line2 && font.widthOfTextAtSize(line2, COVER_SIZE) > maxWidth && line2.length > 3) {
    line2 = line2.slice(0, -1);
  }
  return { size: COVER_SIZE, lines: [line1, line2].filter(Boolean) };
}

function drawCoverCompany(cover, content, fontCover) {
  // Prefer registry legal name on the cover band when available
  const company = content.companyLegalName || content.company || "Prospect";

  // Wipe baked bottom-left placeholder logo (white EVO + script Vending) —
  // sampled dark swirl surround, not COVER_BAND_BG. No replacement content.
  cover.drawRectangle({
    x: COVER_LOGO_BOX.x,
    y: COVER_LOGO_BOX.y,
    width: COVER_LOGO_BOX.width,
    height: COVER_LOGO_BOX.height,
    color: COVER_LOGO_BG,
  });

  // WHY this rectangle exists: the template cover band ships with placeholder
  // client text baked into it (e.g. "EVO Vending"). This solid band fill
  // guarantees a clean overwrite regardless of the new name's length or
  // whether layoutCoverName wraps to two lines — do not remove as "redundant".
  const COVER_BOX_X = COVER_X - 8;
  const COVER_BOX_RIGHT = PAGE_W - 35.3;
  // Two-line block at fixed 36pt with COVER_LEADING (= COVER_SIZE * 1.2)
  const COVER_BOX_TOP = COVER_BASELINE + COVER_SIZE * 0.85 + COVER_LEADING * 0.5;
  const COVER_BOX_BOTTOM = COVER_BASELINE - COVER_SIZE * 0.35 - COVER_LEADING;

  cover.drawRectangle({
    x: COVER_BOX_X,
    y: COVER_BOX_BOTTOM,
    width: COVER_BOX_RIGHT - COVER_BOX_X,
    height: COVER_BOX_TOP - COVER_BOX_BOTTOM,
    color: COVER_BAND_BG,
  });

  const layout = layoutCoverName(company, fontCover);
  const lines = layout.lines;
  const size = layout.size; // always COVER_SIZE
  let baselines;
  if (lines.length === 1) {
    baselines = [COVER_BASELINE];
  } else {
    baselines = [
      COVER_BASELINE + COVER_LEADING * 0.35,
      COVER_BASELINE - COVER_LEADING * 0.75,
    ];
  }
  for (let i = 0; i < lines.length; i++) {
    cover.drawText(lines[i], {
      x: COVER_X,
      y: baselines[i],
      size,
      font: fontCover,
      color: COVER_COLOR,
    });
  }
}

function buildBlocks(content) {
  const c = content || {};
  const blocks = [];
  blocks.push({ type: "h1", text: c.title || `Proposal for ${c.company}` });
  if (c.subtitle) blocks.push({ type: "sub", text: c.subtitle });

  if (c.whoYouAre) {
    blocks.push({ type: "h2", text: "Who You Are?" });
    blocks.push({ type: "p", text: c.whoYouAre });
  }

  // Strengths section (optional) — mirror painPoints rendering
  if (c.strengths && c.strengths.length) {
    blocks.push({ type: "h2", text: "Where You Are Killing It" });
    for (const s of c.strengths) {
      blocks.push({ type: "pain", title: s.title || "", text: s.text || "" });
    }
  }

  if (c.painPoints?.length) {
    blocks.push({ type: "h2", text: "Where Improvements Can Be Made" });
    for (const pp of c.painPoints) {
      blocks.push({ type: "pain", title: pp.title, text: pp.text });
    }
  }

  if (c.solutionPitch || c.tactics?.length) {
    blocks.push({ type: "h2", text: "How Can We Help" });
    if (c.solutionPitch) blocks.push({ type: "p", text: c.solutionPitch });
    if (c.tactics?.length) blocks.push({ type: "bullets", items: c.tactics });
  }

  if (c.deliverables?.length) {
    blocks.push({ type: "h2", text: "Deliverables" });
    blocks.push({ type: "bullets", items: c.deliverables });
  }

  if (c.whyPoints?.length) {
    blocks.push({ type: "h2", text: "Why Us?" });
    blocks.push({ type: "bullets", items: c.whyPoints });
  }

  // CTA intentionally omitted — template contact page is the close.
  return blocks;
}

function wrapText(text, font, size, maxWidth) {
  return wrapToWidth(text, font, size, maxWidth);
}

function maxContentWidth() {
  return BODY.right - BODY.left;
}

function bulletIndent(fonts) {
  return fonts.PB.widthOfTextAtSize(BULLET_MARK, SIZE.body) + 6;
}

/** Section headings — ALWAYS font H at 13pt, color HEADING (near-black). */
function heading(page, text, y, fonts) {
  const size = SIZE.heading;
  const x = BODY.left;
  page.drawText(String(text || ""), {
    x,
    y: y - size,
    size,
    font: fonts.H,
    color: HEADING,
  });
  page.drawRectangle({
    x,
    y: y - size - 4,
    width: 36,
    height: 2,
    color: HEADING,
  });
  return y - size - 12;
}

/**
 * Body copy. Default f: P at 10pt / 1.6. Override f: PB + SUBHEADING only for
 * pain-point / strength title lines (lineHeight 15).
 */
function paragraph(page, text, y, fonts, opts = {}) {
  const f = opts.f ?? fonts.P;
  const size = opts.size ?? SIZE.body;
  const color = opts.color ?? COLORS.ink;
  const lineHeight = opts.lineHeight ?? LINE.body;
  const x = opts.x ?? BODY.left;
  const maxW = opts.maxW ?? maxContentWidth();
  const lines = wrapText(text, f, size, maxW);
  let cy = y;
  for (const line of lines) {
    cy -= size;
    page.drawText(line, { x, y: cy, size, font: f, color });
    cy -= lineHeight - size;
  }
  return cy;
}

/** Bullet marker in PB + HEADING (black); body text in P + BODY ink. */
function bullet(page, items, y, fonts) {
  const size = SIZE.body;
  const lineHeight = LINE.body;
  const x = BODY.left;
  const indent = bulletIndent(fonts);
  const maxW = maxContentWidth() - indent;
  let cy = y;
  for (const item of items) {
    const lines = wrapText(String(item || ""), fonts.P, size, maxW);
    let first = true;
    for (const line of lines) {
      cy -= size;
      if (first) {
        page.drawText(BULLET_MARK, {
          x,
          y: cy,
          size,
          font: fonts.PB,
          color: HEADING,
        });
        first = false;
      }
      page.drawText(line, {
        x: x + indent,
        y: cy,
        size,
        font: fonts.P,
        color: COLORS.ink,
      });
      cy -= lineHeight - size;
    }
    cy -= 2;
  }
  return cy;
}

function measureParagraph(text, font, size, maxW, lineHeight) {
  return wrapText(text, font, size, maxW).length * lineHeight;
}

function measureBlock(block, fonts) {
  const maxW = maxContentWidth();
  if (block.type === "h1") {
    return measureParagraph(String(block.text || "").slice(0, 90), fonts.H, SIZE.title, maxW, SIZE.title + 4) + 4;
  }
  if (block.type === "h2") return SIZE.heading + 12;
  if (block.type === "sub") {
    return measureParagraph(String(block.text || "").slice(0, 110), fonts.R, SIZE.subtitle, maxW, SIZE.subtitle + 4) + 2;
  }
  if (block.type === "p") {
    return measureParagraph(block.text, fonts.P, SIZE.body, maxW, LINE.body);
  }
  if (block.type === "pain") {
    const titleH = block.title
      ? measureParagraph(String(block.title).slice(0, 80), fonts.PB, SIZE.body, maxW, LINE.title)
      : 0;
    const bodyH = measureParagraph(block.text, fonts.P, SIZE.body, maxW - 12, LINE.body);
    return titleH + bodyH + 4;
  }
  if (block.type === "bullets") {
    const indent = bulletIndent(fonts);
    let h = 0;
    for (const item of block.items) {
      h += measureParagraph(item, fonts.P, SIZE.body, maxW - indent, LINE.body) + 2;
    }
    return h + 4;
  }
  return 12;
}

function drawBlock(page, block, y, fonts) {
  const maxW = maxContentWidth();
  const x = BODY.left;
  const subheading = fonts.SUBHEADING || SUBHEADING;

  if (block.type === "h1") {
    // Main title (c.title) — H at 21pt, color TITLE (unchanged per Phase 6 flag)
    return paragraph(page, String(block.text || "").slice(0, 90), y, fonts, {
      f: fonts.H,
      size: SIZE.title,
      color: COLORS.title,
      lineHeight: SIZE.title + 4,
    }) - 4;
  }
  if (block.type === "sub") {
    // Subtitle (c.subtitle) — R + ACCENT
    return paragraph(page, String(block.text || "").slice(0, 110), y, fonts, {
      f: fonts.R,
      size: SIZE.subtitle,
      color: COLORS.accent,
      lineHeight: SIZE.subtitle + 4,
    }) - 2;
  }
  if (block.type === "h2") {
    return heading(page, block.text, y, fonts);
  }
  if (block.type === "p") {
    return paragraph(page, block.text, y, fonts);
  }
  if (block.type === "pain") {
    let cy = y;
    if (block.title) {
      cy = paragraph(page, String(block.title).slice(0, 80), cy, fonts, {
        f: fonts.PB,
        color: subheading,
        lineHeight: LINE.title,
      });
    }
    cy = paragraph(page, block.text, cy, fonts, {
      f: fonts.P,
      color: COLORS.muted,
      x: x + 10,
      maxW: maxW - 12,
    });
    return cy - 4;
  }
  if (block.type === "bullets") {
    return bullet(page, block.items, y, fonts);
  }
  return y;
}
