#!/usr/bin/env node
'use strict';
// node test-editable-psd.cjs RUNTIME_DIR FONT.ttf WORK_DIR
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { build } = require('./build-editable-psd.cjs');

async function main() {
  const [runtimeArg, fontArg, workArg] = process.argv.slice(2);
  if (!runtimeArg || !fontArg || !workArg) throw new Error('Usage: node test-editable-psd.cjs RUNTIME_DIR FONT.ttf WORK_DIR');
  const runtime = path.resolve(runtimeArg), fontFile = path.resolve(fontArg), dir = path.resolve(workArg);
  fs.mkdirSync(dir, { recursive: true });
  const req = createRequire(path.join(runtime, 'package.json'));
  const { createCanvas, GlobalFonts } = req('@napi-rs/canvas');
  const font = { file: fontFile, postscriptName: req('fontkit').openSync(fontFile).postscriptName };
  for (const [name, fill] of [['back', '#0000ff'], ['front', '#ff0000']]) {
    const canvas = createCanvas(120, 100);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = fill; ctx.fillRect(0, 0, 120, 100);
    fs.writeFileSync(path.join(dir, `${name}.png`), canvas.toBuffer('image/png'));
  }
  GlobalFonts.registerFromPath(fontFile, 'ControlledSourceFont');
  const source = createCanvas(140, 120);
  const sourceCtx = source.getContext('2d');
  sourceCtx.fillStyle = '#202020'; sourceCtx.fillRect(0, 0, 140, 120);
  sourceCtx.fillStyle = '#ffffff'; sourceCtx.font = '16px "ControlledSourceFont"';
  sourceCtx.fillText('First line', 10, 28); sourceCtx.fillText('Second line', 10, 50);
  fs.writeFileSync(path.join(dir, 'font-source.png'), source.toBuffer('image/png'));
  const comparison = createCanvas(280, 120);
  comparison.getContext('2d').drawImage(source, 0, 0);
  comparison.getContext('2d').drawImage(source, 140, 0);
  fs.writeFileSync(path.join(dir, 'font-comparison.png'), comparison.toBuffer('image/png'));
  const text = { type: 'text', name: 'editable', text: 'First line\nSecond line', font,
    fontSize: 16, x: 70, baseline: 28, align: 'center', leading: 22, tracking: 25, color: '#ffffff',
    fontVerification: { status: 'verified', reviewedPostscriptName: font.postscriptName,
      sourceEvidence: 'Controlled synthetic source uses the specified font file; this fixture does not verify any real poster font.',
      referenceFile: 'font-source.png', comparisonFile: 'font-comparison.png' } };
  const spec = { width: 140, height: 120, layersPanelTopToBottom: [
    { type: 'group', name: 'front-group', children: [text,
      { type: 'image', name: 'front-red', file: 'front.png', left: 10, top: 10 }] },
    { type: 'image', name: 'back-blue', file: 'back.png' },
    { type: 'image', name: 'hidden-reference', file: 'back.png', visible: false },
  ] };
  const result = await build(spec, dir, runtime);
  fs.writeFileSync(path.join(dir, 'overlap-and-multiline.psd'), result.buffer);
  const saved = req('ag-psd').readPsd(result.buffer, { skipCompositeImageData: true, skipThumbnail: true });
  assert.equal(saved.children[0].name, 'hidden-reference');
  assert.equal(saved.children.at(-1).children.at(-1).text.text, text.text);
  assert.equal(saved.children.at(-1).children.at(-1).text.style.tracking, 25);
  assert.equal(saved.children.at(-1).children.at(-1).text.style.leading, 22);
  assert.equal(result.report.typeLayerCount, 1);
  const badFont = structuredClone(spec);
  badFont.layersPanelTopToBottom[0].children[0].font.postscriptName = 'NOT-THE-FONT';
  badFont.layersPanelTopToBottom[0].children[0].fontVerification.reviewedPostscriptName = 'NOT-THE-FONT';
  await assert.rejects(build(badFont, dir, runtime), /PostScript name mismatch/);
  const missingGlyph = structuredClone(spec);
  missingGlyph.layersPanelTopToBottom[0].children[0].text = 'Missing: \u{10ffff}';
  await assert.rejects(build(missingGlyph, dir, runtime), /has no glyph/);
  const trailing = structuredClone(spec);
  trailing.layersPanelTopToBottom[0].children[0].text = 'End with newline\n';
  await assert.rejects(build(trailing, dir, runtime), /Trailing newline/);
  for (const status of [undefined, 'unresolved', 'mismatch', 'approximate']) {
    const unreviewed = structuredClone(spec);
    const item = unreviewed.layersPanelTopToBottom[0].children[0];
    item.fontMatch = 'exact'; // The old free-text field must never bypass the gate.
    if (status === undefined) delete item.fontVerification;
    else item.fontVerification.status = status;
    await assert.rejects(build(unreviewed, dir, runtime), /font verification requires/);
  }
  const stale = structuredClone(spec);
  stale.layersPanelTopToBottom[0].children[0].fontVerification.reviewedPostscriptName = 'OTHER-FONT';
  await assert.rejects(build(stale, dir, runtime), /reviewed font does not match/);
  const missingComparison = structuredClone(spec);
  missingComparison.layersPanelTopToBottom[0].children[0].fontVerification.comparisonFile = 'missing-comparison.png';
  await assert.rejects(build(missingComparison, dir, runtime), /evidence image missing/);
  const sameEvidence = structuredClone(spec);
  sameEvidence.layersPanelTopToBottom[0].children[0].fontVerification.comparisonFile = 'font-source.png';
  await assert.rejects(build(sameEvidence, dir, runtime), /comparison image must be separate/);
  const emptyEvidence = structuredClone(spec);
  emptyEvidence.layersPanelTopToBottom[0].children[0].fontVerification.sourceEvidence = '';
  await assert.rejects(build(emptyEvidence, dir, runtime), /requires sourceEvidence/);
  const substitute = structuredClone(spec);
  const review = substitute.layersPanelTopToBottom[0].children[0].fontVerification;
  review.status = 'substitution-approved';
  await assert.rejects(build(substitute, dir, runtime), /explicit user approvalEvidence/);
  review.approvalEvidence = 'Synthetic regression fixture simulates explicit acceptance of this font for this text; not an actual user authorization.';
  const accepted = await build(substitute, dir, runtime);
  assert.equal(accepted.report.layers.find(l => l.type === 'text').fontVerification.status, 'substitution-approved');
  assert.equal(accepted.report.checks.fontReviewRecordsChecked, true);
  assert.match(accepted.report.checks.sourceFontVisualMatch, /not automatically measured/);
  console.log('PASS: multiline type metadata, nested layer order, hidden reference, font mismatch, missing-glyph and trailing-newline rejection.');
  console.log('PASS: missing/unresolved/mismatched review, stale font name, missing comparison, reused source image, missing source evidence and unapproved substitution are rejected. Approved substitution retains a separate status.');
  console.log('Independent reader must confirm overlap-and-multiline.psd pixel (20,80) is red and (5,80) is blue.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
