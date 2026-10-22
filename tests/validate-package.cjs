const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const required = ['SKILL.md', 'agents/openai.yaml', 'LICENSE', 'README.md',
  'references/core-prompt.md', 'references/ps-mode.md', 'references/font-verification.md',
  'references/ps-editable-text.md', 'references/psd-assembly.md', 'references/ps-compatibility.md',
  'references/output-resolution.md', 'references/custom-image-api.md', 'references/concurrent-workflow.md',
  'scripts/build-editable-psd.cjs', 'scripts/test-editable-psd.cjs', 'scripts/element-pool.js', 'scripts/image_api.py'];
for (const name of required) assert.ok(fs.statSync(path.join(root, name)).isFile(), 'Missing: ' + name);
const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
assert.match(skill, /^---\r?\nname: lsf-image-to-layered-psd\r?\ndescription:/);
assert.match(skill, /原生文字/);
assert.match(skill, /候选/);
assert.match(skill, /4096/);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '__pycache__', 'work', 'outputs', '.venv'].includes(entry.name)) continue;
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(name); else files.push(name);
  }
}
walk(root);
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (/^(references|scripts|agents)\//.test(relative) || relative === 'SKILL.md') {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/figma|geometry-repair|geometry-regularization/i.test(text), 'Non-PS workflow leaked: ' + relative);
    assert.ok(!/[A-Z]:[\\/](?:Users|codex_temp|CodexData)/i.test(text), 'Machine path: ' + relative);
  }
  if (relative.endsWith('.md')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      const destination = path.resolve(path.dirname(file), decodeURIComponent(link));
      assert.ok(destination.startsWith(root + path.sep), 'Link escapes package: ' + relative + ': ' + link);
      assert.ok(fs.existsSync(destination), 'Broken link: ' + relative + ': ' + link);
    }
  }
}
const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/image-api.example.json'), 'utf8'));
assert.equal(new URL(example.base_url).hostname, 'api.example.invalid');
assert.equal(example.api_key_env, 'LSF_IMAGE_API_KEY');
assert.ok(!Object.hasOwn(example, 'api_key'));
assert.match(fs.readFileSync(path.join(root, 'agents/openai.yaml'), 'utf8'), /\$lsf-image-to-layered-psd/);
console.log('PASS: required resources, local links, PS-only workflow boundary, portable paths and non-secret API example.');
