// Generated from composition.html and element-template.js by node build.mjs.
// Six real transparent layer groups, CSS perspective, no iframe or flattened cover.
const markup = __MARKUP_JSON__;
const css = __CSS_JSON__;
class LeiLayerCover extends HTMLElement {
  static observedAttributes = ['lang', 'formats'];
  constructor() {
    super();
    const root = this.attachShadow({mode:'open'});
    root.innerHTML = '<style>' + css + '</style>' + markup;
    this.cover = root.querySelector('.cover');
    root.querySelectorAll('img').forEach(img => {
      img.src = new URL(img.getAttribute('src'), import.meta.url).href;
      img.decoding = 'async';
      img.draggable = false;
    });
    this.resizeObserver = new ResizeObserver(entries => {
      this.cover.style.setProperty('--s', entries[0].contentRect.width / 1500);
    });
  }
  connectedCallback() {
    this.cover.style.setProperty('--s', this.clientWidth / 1500);
    this.resizeObserver.observe(this);
    this.updateCopy();
  }
  disconnectedCallback() { this.resizeObserver.disconnect(); }
  attributeChangedCallback() { this.updateCopy(); }
  updateCopy() {
    const english = this.getAttribute('lang')?.startsWith('en');
    this.cover.classList.toggle('cover-en', !!english);
    this.cover.querySelector('.title').innerHTML = (english ? 'Layer Split' : '图层拆分') + '<small>Skill</small>';
    this.cover.querySelector('.tagline').textContent = english ? 'Turn an image into editable layers' : '把图片，拆成可编辑的图层';
    this.cover.querySelector('.formats').textContent = this.getAttribute('formats') || 'Photoshop / PSD';
  }
}
if (!customElements.get('lei-layer-cover')) customElements.define('lei-layer-cover', LeiLayerCover);
