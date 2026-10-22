#!/usr/bin/env node
'use strict';

// Build RGB/8 PSDs with real horizontal type layers and matching bitmap caches.
// No OCR, image generation, font downloads, or implicit background removal.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function fail(message) { throw new Error(message); }
function number(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${name} must be a finite number in [${min}, ${max}]`);
  return value;
}
function color(value) {
  if (!/^#[0-9a-f]{6}$/i.test(value || '')) fail('color must be #RRGGBB');
  return { r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16) };
}
function trimCanvas(canvas, createCanvas) {
  const ctx = canvas.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3]) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) fail('text has no visible pixels or lies outside the canvas');
  const cropped = createCanvas(right - left + 1, bottom - top + 1);
  cropped.getContext('2d').drawImage(canvas, -left, -top);
  return { canvas: cropped, left, top };
}

async function build(manifest, baseDir, runtimeDir) {
  const req = runtimeDir ? createRequire(path.join(path.resolve(runtimeDir), 'package.json')) : require;
  let psd, napi, fontkit;
  try {
    psd = req('ag-psd'); napi = req('@napi-rs/canvas'); fontkit = req('fontkit');
  } catch (e) {
    fail(`Missing dependencies: install ag-psd@31.0.3 @napi-rs/canvas@1.0.11 fontkit@2.0.4 in a task runtime and pass --runtime DIR. ${e.message}`);
  }
  const { createCanvas, loadImage, GlobalFonts } = napi;
  psd.initializeCanvas(createCanvas);
  const width = number(manifest.width, 'width', 1, 30000);
  const height = number(manifest.height, 'height', 1, 30000);
  if (!Number.isInteger(width) || !Number.isInteger(height)) fail('canvas size must use integer pixels');
  if (!Array.isArray(manifest.layersPanelTopToBottom)) fail('layersPanelTopToBottom is required');
  const fonts = new Map(), names = new Set(), report = [], evidenceImages = new Set();
  let id = 1;
  const resolve = file => path.resolve(baseDir, file);

  async function checkFontVerification(spec) {
    const review = spec.fontVerification;
    const prefix = `${spec.name}: font verification`;
    if (!review || !['verified', 'substitution-approved'].includes(review.status))
      fail(`${prefix} requires verified source-font review or explicitly approved substitution; unresolved, mismatched and missing records cannot be written`);
    for (const key of ['reviewedPostscriptName', 'sourceEvidence', 'referenceFile', 'comparisonFile']) {
      if (typeof review[key] !== 'string' || !review[key].trim()) fail(`${prefix} requires ${key}`);
    }
    if (review.reviewedPostscriptName !== spec.font?.postscriptName)
      fail(`${prefix}: reviewed font does not match the selected PostScript name`);
    if (review.status === 'substitution-approved' && (typeof review.approvalEvidence !== 'string' || !review.approvalEvidence.trim()))
      fail(`${prefix}: substitution requires explicit user approvalEvidence for this font and text`);
    const files = [review.referenceFile, review.comparisonFile].map(resolve);
    for (const file of files) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${prefix}: evidence image missing: ${file}`);
      if (!evidenceImages.has(file)) {
        try { await loadImage(file); } catch { fail(`${prefix}: evidence must be a readable image: ${file}`); }
        evidenceImages.add(file);
      }
    }
    if (fs.realpathSync(files[0]) === fs.realpathSync(files[1]))
      fail(`${prefix}: comparison image must be separate from the source reference`);
    return { status: review.status, reviewedPostscriptName: review.reviewedPostscriptName,
      sourceEvidence: review.sourceEvidence, referenceFile: review.referenceFile, comparisonFile: review.comparisonFile,
      ...(review.status === 'substitution-approved' ? { approvalEvidence: review.approvalEvidence } : {}) };
  }

  function loadFont(spec, text) {
    if (!spec || !spec.file || !spec.postscriptName) fail('font.file and font.postscriptName are required');
    const file = resolve(spec.file);
    const key = `${file}|${spec.postscriptName}`;
    if (!fonts.has(key)) {
      const opened = fontkit.openSync(file);
      if (opened.fonts) fail('Font collections require selecting a standalone face first; supply a TTF/OTF font file');
      const font = opened;
      if (!font || font.postscriptName !== spec.postscriptName)
        fail(`Font PostScript name mismatch: expected ${spec.postscriptName} in ${file}`);
      const alias = `PsdTypeFont${fonts.size}`;
      if (!GlobalFonts.registerFromPath(file, alias)) fail(`Could not register ${file}`);
      fonts.set(key, { font, alias, file });
    }
    const found = fonts.get(key);
    for (const ch of text) {
      if (ch !== '\n' && ch !== '\r' && !found.font.hasGlyphForCodePoint(ch.codePointAt(0)))
        fail(`Font ${spec.postscriptName} has no glyph for ${JSON.stringify(ch)}; fallback is not allowed`);
    }
    return found;
  }

  async function layer(spec, parentVisible = true) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) fail('Every layer needs a nonempty name');
    if (names.has(spec.name)) fail(`Duplicate layer name: ${spec.name}`);
    names.add(spec.name);
    const visible = spec.visible !== false;
    const common = { name: spec.name, id: id++, hidden: !visible, opacity: number(spec.opacity ?? 1, 'opacity', 0, 1), blendMode: 'normal' };
    if (spec.type === 'group') {
      if (!Array.isArray(spec.children)) fail(`${spec.name}: group children must be an array`);
      const children = [];
      for (const item of spec.children) children.push(await layer(item, parentVisible && visible));
      return { ...common, opened: true, children };
    }
    if (spec.type === 'image') {
      const image = await loadImage(resolve(spec.file));
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      const left = number(spec.left ?? 0, 'image.left'), top = number(spec.top ?? 0, 'image.top');
      report.push({ name: spec.name, type: 'image', visible: visible && parentVisible, left, top, width: image.width, height: image.height });
      return { ...common, left, top, canvas };
    }
    if (spec.type !== 'text') fail(`${spec.name}: supported types are image, group, text`);
    if (typeof spec.text !== 'string' || !spec.text.trim()) fail(`${spec.name}: nonempty text is required`);
    const text = spec.text.replace(/\r\n?/g, '\n');
    if (text.endsWith('\n')) fail('Trailing newline is not supported by the verified ag-psd readback; remove the trailing blank line');
    const fontVerification = await checkFontVerification(spec);
    const { alias } = loadFont(spec.font, text);
    const size = number(spec.fontSize, 'fontSize', 0.1, 10000);
    const x = number(spec.x, 'x'), baseline = number(spec.baseline, 'baseline');
    const leading = number(spec.leading ?? size * 1.2, 'leading', 0.1);
    const tracking = number(spec.tracking ?? 0, 'tracking', -1000, 10000);
    const sx = number(spec.horizontalScale ?? 1, 'horizontalScale', 0.01, 100);
    const sy = number(spec.verticalScale ?? 1, 'verticalScale', 0.01, 100);
    const align = spec.align ?? 'left';
    if (!['left', 'center', 'right'].includes(align)) fail('align must be left, center, or right');
    const rgb = color(spec.color ?? '#000000');
    const full = createCanvas(width, height), ctx = full.getContext('2d');
    ctx.fillStyle = spec.color ?? '#000000';
    ctx.font = `${size}px "${alias}"`;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = align;
    ctx.fontKerning = 'normal';
    // Canvas letterSpacing and PSD Tracking both use em fractions, with PSD /1000.
    ctx.letterSpacing = `${tracking * size / 1000}px`;
    ctx.translate(x, baseline); ctx.scale(sx, sy);
    text.split('\n').forEach((line, i) => ctx.fillText(line, 0, i * leading));
    const bitmap = trimCanvas(full, createCanvas);
    const typeData = {
      text, transform: [1, 0, 0, 1, x, baseline], shapeType: 'point', pointBase: [0, 0],
      orientation: 'horizontal', antiAlias: 'sharp', useFractionalGlyphWidths: true,
      style: {
        font: { name: spec.font.postscriptName }, fontSize: size, fillColor: rgb,
        autoLeading: false, leading, tracking, horizontalScale: sx, verticalScale: sy,
        autoKerning: true, ligatures: true,
      },
      paragraphStyle: { justification: align, autoHyphenate: false },
    };
    report.push({ name: spec.name, type: 'text', visible: visible && parentVisible, text,
      font: spec.font.postscriptName, fontSize: size, x, baseline, align, leading, tracking,
      horizontalScale: sx, verticalScale: sy, color: spec.color ?? '#000000',
      fontVerification, left: bitmap.left, top: bitmap.top,
      width: bitmap.canvas.width, height: bitmap.canvas.height });
    return { ...common, ...bitmap, text: typeData };
  }

  const document = { width, height, children: [], imageResources: {
    resolutionInfo: { horizontalResolution: 72, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches',
      verticalResolution: 72, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' },
  } };
  for (const item of manifest.layersPanelTopToBottom) document.children.push(await layer(item));

  function composite(layers, target) {
    const ctx = target.getContext('2d');
    for (const item of [...layers].reverse()) {
      if (item.hidden) continue;
      if (item.children) {
        const isolated = createCanvas(width, height);
        composite(item.children, isolated);
        ctx.save(); ctx.globalAlpha = item.opacity ?? 1; ctx.drawImage(isolated, 0, 0); ctx.restore();
      } else if (item.canvas) {
        ctx.save(); ctx.globalAlpha = item.opacity ?? 1;
        ctx.drawImage(item.canvas, item.left ?? 0, item.top ?? 0); ctx.restore();
      }
    }
  }
  document.canvas = createCanvas(width, height);
  composite(document.children, document.canvas);
  // Invalidate only when updating existing text without a freshly rendered cache.
  // ag-psd 31.0.3 stores children BACK TO FRONT (verified with psd-tools and
  // psdWriter.addChildren), despite README_PSD.md describing the opposite.
  // Keep the manifest in panel order; convert only at the library boundary.
  function reverseTree(nodes) {
    return [...nodes].reverse().map(node => node.children ? { ...node, children: reverseTree(node.children) } : node);
  }
  const buffer = psd.writePsdBuffer({ ...document, children: reverseTree(document.children) }, { generateThumbnail: true, invalidateTextLayers: false });
  const decoded = psd.readPsd(buffer, { skipCompositeImageData: true, skipThumbnail: true });
  const fromSavedLayers = createCanvas(width, height);
  composite(reverseTree(decoded.children), fromSavedLayers);
  const decodedTexts = [];
  function collect(nodes) { for (const node of nodes) {
    if (node.children) collect(node.children);
    if (node.text) decodedTexts.push({ name: node.name, text: node.text.text.replace(/\r\n?/g, '\n'), font: node.text.style?.font?.name });
  } }
  collect(decoded.children);
  for (const item of report.filter(r => r.type === 'text')) {
    const saved = decodedTexts.find(t => t.name === item.name);
    if (!saved || saved.text !== item.text || saved.font !== item.font) fail(`Type data roundtrip failed for ${item.name}`);
  }
  return { buffer, preview: fromSavedLayers.toBuffer('image/png'), report: {
    width, height, typeLayerCount: decodedTexts.length, layers: report,
    checks: { typeDataRoundtrip: true, previewFromSavedLayerBitmaps: true, fontReviewRecordsChecked: true,
      sourceFontVisualMatch: 'requires external visual review; not automatically measured by this script',
      independentReader: 'not run by this script', photoshop: 'not run by this script' },
    dependencies: { agPsd: req('ag-psd/package.json').version, canvas: req('@napi-rs/canvas/package.json').version },
    limitations: ['Horizontal point text only; no automatic OCR or image cleanup.',
      'Fonts are referenced, not embedded. Install the same font when editing.',
      'Font identity and visual fidelity require source evidence and comparison review; loading a font does not establish a match.',
      'Bitmap cache rendering does not prove Photoshop text-engine fidelity.'],
  } };
}

async function main(argv) {
  if (!argv.length || argv.includes('--help')) {
    console.log('Usage: node build-editable-psd.cjs MANIFEST.json --output FILE.psd [--runtime DIR] [--overwrite]\nText layers require fontVerification: {status,reviewedPostscriptName,sourceEvidence,referenceFile,comparisonFile}; substitution-approved also requires explicit user approvalEvidence.\nOutputs FILE.psd, FILE.preview.png, FILE.report.json. Asset and evidence paths resolve against the manifest.');
    return;
  }
  const manifestFile = path.resolve(argv[0]);
  let output, runtime, overwrite = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--output' && argv[i + 1]) output = path.resolve(argv[++i]);
    else if (argv[i] === '--runtime' && argv[i + 1]) runtime = path.resolve(argv[++i]);
    else if (argv[i] === '--overwrite') overwrite = true;
    else fail(`Unknown or missing argument: ${argv[i]}`);
  }
  if (!output || !/\.psd$/i.test(output)) fail('--output FILE.psd is required');
  const prefix = output.slice(0, -4);
  const paths = [output, `${prefix}.preview.png`, `${prefix}.report.json`];
  if (!overwrite && paths.some(file => fs.existsSync(file))) fail('Output exists. Choose another path or explicitly pass --overwrite.');
  const result = await build(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), path.dirname(manifestFile), runtime);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result.buffer);
  fs.writeFileSync(paths[1], result.preview);
  fs.writeFileSync(paths[2], JSON.stringify(result.report, null, 2) + '\n');
  console.log(JSON.stringify({ output, typeLayerCount: result.report.typeLayerCount, width: result.report.width, height: result.report.height }));
}

module.exports = { build };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
