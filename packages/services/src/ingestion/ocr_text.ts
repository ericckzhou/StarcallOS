// Post-processing for OCR output (image importer). Tesseract returns physical
// lines; the text-source pipeline (segmentText) splits blocks on blank lines and
// treats short standalone lines as weak headings, so raw OCR would turn every
// wrapped line into its own block. This rejoins words hyphenated across a line
// break, unwraps lines inside a paragraph, and drops lines that are pure noise.
// Pure: no OCR engine here (that lives in Electron main).

// A line with no letters or digits at all (scan specks, rules, bullets alone).
function isNoiseLine(line: string): boolean {
  return !/[\p{L}\p{N}]/u.test(line);
}

// Markdown-ish structure the text pipeline understands; keep these on their
// own line instead of merging them into the previous paragraph line.
function startsOwnLine(line: string): boolean {
  return /^(#{1,6}\s|[-*•]\s|\d+[.)]\s)/.test(line);
}

// Unwrap one paragraph's physical lines into running text (empty if all noise).
function unwrapLines(rawLines: string[]): string {
  const lines = rawLines.map(l => l.trim()).filter(l => l && !isNoiseLine(l));
  const merged: string[] = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    if (prev === undefined || startsOwnLine(line)) { merged.push(line); continue; }
    // "opti-" + "mization" → "optimization" (lowercase continuation only, so
    // real compounds split as "state-" / "Of-the-art" keep their hyphen).
    if (/[\p{L}]-$/u.test(prev) && /^\p{Ll}/u.test(line)) {
      merged[merged.length - 1] = prev.slice(0, -1) + line;
    } else {
      merged[merged.length - 1] = `${prev} ${line}`;
    }
  }
  return merged.join('\n');
}

function finish(paragraphs: string[]): string {
  return paragraphs.filter(Boolean).join('\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// Plain-text fallback: paragraphs are blank-line separated.
export function ocrTextToSource(raw: string): string {
  return finish(raw.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(p => unwrapLines(p.split('\n'))));
}

export interface OcrLine { text: string; height: number }
export interface OcrParagraph { lines: OcrLine[] }

// A line this much taller than the median line is set in a larger font: a
// heading. Emitted as `# …` so segmentText gives it a strong heading hint.
export const OCR_HEADING_HEIGHT_RATIO = 1.3;

// Structured path: uses the engine's own paragraph segmentation (blank lines
// between paragraphs) and line heights (headings). Without this a heading
// printed directly above its paragraph is unwrapped into the first sentence.
export function ocrParagraphsToSource(paragraphs: OcrParagraph[]): string {
  const heights = paragraphs
    .flatMap(p => p.lines)
    .filter(l => l.text.trim() && !isNoiseLine(l.text) && l.height > 0)
    .map(l => l.height)
    .sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor((heights.length - 1) / 2)] : 0;
  const isHeading = (l: OcrLine) =>
    median > 0 && l.height >= median * OCR_HEADING_HEIGHT_RATIO && l.text.trim().length <= 80;

  const out: string[] = [];
  for (const p of paragraphs) {
    let body: string[] = [];
    let heading: string[] = [];
    const flushBody = () => { if (body.length) out.push(unwrapLines(body)); body = []; };
    const flushHeading = () => {
      const h = unwrapLines(heading).replace(/\n/g, ' ');
      if (h) out.push(`# ${h.replace(/^#+\s*/, '')}`);
      heading = [];
    };
    for (const line of p.lines) {
      if (isHeading(line)) { flushBody(); heading.push(line.text); }
      else { flushHeading(); body.push(line.text); }
    }
    flushHeading();
    flushBody();
  }
  return finish(out);
}

// Mean word confidence below this means the image is very likely not text (a
// photo, a diagram) or unreadable; the importer reports it instead of creating
// a junk source. Tesseract confidences are 0–100.
export const OCR_MIN_CONFIDENCE = 30;
