(function () {
  'use strict';

  const currentScript =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  if (!currentScript) return;

  const sessionId = currentScript.getAttribute('data-session');
  const theme = currentScript.getAttribute('data-theme') || 'auto';
  const layout = currentScript.getAttribute('data-layout') || 'grid';

  const apiOrigin = (function () {
    try {
      return new URL(currentScript.src).origin;
    } catch {
      return '';
    }
  })();

  if (!sessionId) {
    console.warn('[OpenStore widget] missing data-session attribute');
    return;
  }

  const css = `
    .os-widget { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 1rem; }
    .os-widget__header { display:flex; align-items:center; justify-content:space-between; margin-bottom:1rem; }
    .os-widget__title { font-size:1.25rem; font-weight:700; margin:0; }
    .os-widget__badge { font-size:0.7rem; color:#00C285; letter-spacing:0.05em; text-transform:uppercase; }
    .os-widget__grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:1rem; }
    .os-widget__card { border:1px solid rgba(0,0,0,0.08); border-radius:12px; padding:1rem; background:#fff; transition:transform .2s ease, box-shadow .2s ease; display:flex; flex-direction:column; gap:.5rem; text-decoration:none; color:inherit; }
    .os-widget__card:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,0,0,0.06); }
    .os-widget__img { width:100%; aspect-ratio:1/1; object-fit:cover; border-radius:8px; background:#f5f5f5; }
    .os-widget__emoji { font-size:2rem; margin-bottom:.5rem; }
    .os-widget__name { font-size:1rem; font-weight:600; margin:.25rem 0; }
    .os-widget__desc { font-size:.85rem; color:#666; margin:.25rem 0 .75rem; line-height:1.4; }
    .os-widget__price { font-size:1.05rem; font-weight:700; }
    .os-widget__meta { display:flex; justify-content:space-between; align-items:center; margin-top:.5rem; }
    .os-widget__supplier { font-size:.7rem; padding:.2rem .5rem; border-radius:4px; background:#f0fdf4; color:#15803d; text-transform:uppercase; letter-spacing:.05em; }
    .os-widget__loading, .os-widget__error { text-align:center; padding:2rem; color:#666; font-size:.95rem; }
    .os-widget--dark .os-widget__card { background:#0c1018; border-color:rgba(255,255,255,0.08); color:#f0f4ff; }
    .os-widget--dark .os-widget__desc { color:#8892a4; }
    .os-widget--dark .os-widget__supplier { background:rgba(0,229,160,0.1); color:#00E5A0; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const container = document.createElement('div');
  container.className = 'os-widget';
  if (theme === 'dark') container.classList.add('os-widget--dark');
  if (
    theme === 'auto' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    container.classList.add('os-widget--dark');
  }

  container.innerHTML =
    '<div class="os-widget__loading">Loading sourced products…</div>';

  const mount =
    currentScript.parentNode &&
    currentScript.parentNode.nodeType === 1 &&
    currentScript.parentNode.tagName !== 'HEAD'
      ? currentScript.parentNode
      : document.body;
  mount.insertBefore(container, currentScript);

  fetch(apiOrigin + '/api/session/' + encodeURIComponent(sessionId))
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.products || !data.products.length) {
        container.innerHTML =
          '<div class="os-widget__error">No sourced products yet.</div>';
        return;
      }
      render(container, data.products, layout);
    })
    .catch((err) => {
      console.error('[OpenStore widget]', err);
      container.innerHTML =
        '<div class="os-widget__error">Could not load products.</div>';
    });

  function render(root, products, layout) {
    const visible = products.slice(0, 5);
    const items = visible
      .map(function (p) {
        const margin =
          typeof p.marginPercent === 'number' ? '+' + p.marginPercent + '%' : '';
        const tag = p.supplierUrl ? 'a' : 'div';
        const hrefAttr = p.supplierUrl
          ? ' href="' + esc(p.supplierUrl) + '" target="_blank" rel="noopener"'
          : '';
        const imgHtml = p.imageUrl
          ? '<img class="os-widget__img" alt="' + esc(p.name) + '" loading="lazy" src="' + esc(p.imageUrl) + '" />'
          : '<div class="os-widget__emoji">' + esc(p.emoji || '📦') + '</div>';
        return (
          '<' + tag + ' class="os-widget__card"' + hrefAttr + '>' +
          imgHtml +
          '<div class="os-widget__name">' + esc(p.name) + '</div>' +
          '<div class="os-widget__desc">' + esc(p.description || '') + '</div>' +
          '<div class="os-widget__price">$' + fmt(p.sellPrice) + '</div>' +
          '<div class="os-widget__meta">' +
          '<span class="os-widget__supplier">' + esc(p.supplier) + '</span>' +
          '<span style="font-size:.8rem;color:#00C285;font-weight:600">' + margin + '</span>' +
          '</div>' +
          '</' + tag + '>'
        );
      })
      .join('');

    root.innerHTML =
      '<div class="os-widget__header">' +
      '<h3 class="os-widget__title">Recommended for you</h3>' +
      '<span class="os-widget__badge">✦ Sourced by OpenStore.ai</span>' +
      '</div>' +
      '<div class="os-widget__grid">' +
      items +
      '</div>';
  }

  function fmt(n) {
    const v = Number(n);
    if (!isFinite(v)) return '0';
    return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
