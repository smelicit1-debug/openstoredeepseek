(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const form = $('urlForm');
  const input = $('urlInput');
  const analyzeBtn = $('analyzeBtn');
  const sampleUrl = $('sampleUrl');

  const resultsSection = $('results');
  const statusBox = $('resultStatus');
  const statusText = $('statusText');
  const resultBody = $('resultBody');
  const resultError = $('resultError');

  const brandHeading = $('brandHeading');
  const brandCard = $('brandCard');
  const productCount = $('productCount');
  const productGrid = $('productGrid');

  const exportBtn = $('exportBtn');
  const addToSiteBtn = $('addToSiteBtn');

  const modal = $('embedModal');
  const modalCode = $('modalCode');
  const modalClose = $('modalClose');
  const copyBtn = $('copyEmbedBtn');
  const copyHint = $('copyHint');

  const subModal = $('subModal');
  const subModalClose = $('subModalClose');
  const subCtaBtn = $('subCtaBtn');

  const productModal = $('productModal');
  const productModalClose = $('productModalClose');
  const pmEmoji = $('pmEmoji');
  const pmImg = $('pmImg');
  const pmName = $('pmName');
  const pmChinese = $('pmChinese');
  const pmDesc = $('pmDesc');
  const pmCost = $('pmCost');
  const pmSell = $('pmSell');
  const pmMargin = $('pmMargin');
  const pmMoq = $('pmMoq');
  const pmLead = $('pmLead');
  const pmLinks = $('pmLinks');
  const pmDeepBtn = $('pmDeepBtn');
  const pmDeepSection = $('pmDeepSection');
  const pmDeepBody = $('pmDeepBody');

  const FREE_LIMIT = 5;
  const SUB_KEY = 'openstore.subscribed';
  let currentSessionId = null;
  let currentProducts = [];
  let openProductIndex = -1;
  let isSubscribed = localStorage.getItem(SUB_KEY) === 'true';

  sampleUrl?.addEventListener('click', () => {
    input.value = sampleUrl.textContent.trim();
    input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    await runFlow(raw);
  });

  async function runFlow(raw) {
    setBusy(true);
    showStatus('Analyzing your site');
    showResults();
    hideError();

    try {
      const a = await fetchJson('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });

      currentSessionId = a.sessionId;
      renderBrand(a.analysis);

      showStatus('Sourcing products & verifying real supplier listings');
      const s = await fetchJson('/api/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          analysis: a.analysis,
        }),
      });

      currentSessionId = s.sessionId || currentSessionId;
      renderProducts(s.products);
      hideStatus();
      revealBody();
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      hideStatus();
      showError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Server returned non-JSON (status ${res.status})`);
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function setBusy(busy) {
    analyzeBtn.disabled = busy;
    analyzeBtn.textContent = busy ? 'Working…' : 'Analyze & Source →';
    input.disabled = busy;
  }

  function showResults() { resultsSection.style.display = 'block'; }
  function showStatus(msg) {
    statusBox.style.display = 'flex';
    resultBody.style.display = 'none';
    statusText.textContent = msg + '…';
  }
  function hideStatus() { statusBox.style.display = 'none'; }
  function revealBody() { resultBody.style.display = 'block'; }
  function showError(msg) {
    resultError.style.display = 'block';
    resultError.textContent = '× ' + msg;
  }
  function hideError() {
    resultError.style.display = 'none';
    resultError.textContent = '';
  }

  function renderBrand(a) {
    brandHeading.textContent = a.brandName ? a.brandName : 'Your brand, decoded';
    const priceText = a.priceRange
      ? `$${a.priceRange.min} – $${a.priceRange.max}`
      : '—';
    const types = Array.isArray(a.productTypes)
      ? a.productTypes.join(', ')
      : '—';

    brandCard.innerHTML = '';
    addField('Brand', a.brandName || '—');
    addField('Niche', a.niche || '—');
    addField('Product types', types);
    addField('Price range', priceText);
    addField('Target audience', a.targetAudience || '—');
    if (a.summary) addField('Summary', a.summary);
  }

  function addField(label, value) {
    const wrap = document.createElement('div');
    wrap.className = 'ba-field';
    const l = document.createElement('div');
    l.className = 'ba-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'ba-value';
    v.textContent = value;
    wrap.appendChild(l);
    wrap.appendChild(v);
    brandCard.appendChild(wrap);
  }

  function renderProducts(products) {
    currentProducts = products || [];
    productGrid.innerHTML = '';
    const total = products.length;
    const lockedCount = isSubscribed ? 0 : Math.max(0, total - FREE_LIMIT);
    productCount.textContent = isSubscribed
      ? `${total} sourced products`
      : `${total} sourced products · ${Math.min(FREE_LIMIT, total)} free preview`;

    products.forEach((p, i) => {
      const locked = !isSubscribed && i >= FREE_LIMIT;
      const card = document.createElement('div');
      card.className = 'product-card' + (locked ? ' locked' : '');

      const emoji = escapeHtml(p.emoji || '📦');
      const verified = p.realListing && p.realListing.url;
      const supplierLabel = verified ? p.realListing.supplier || p.supplier : p.supplier;
      const supplierLink = p.supplierUrl
        ? `<a class="product-supplier-link" href="${escapeAttr(p.supplierUrl)}" target="_blank" rel="noopener">
             ${verified ? 'Open verified listing' : 'View on ' + escapeHtml(supplierLabel)} <span class="arrow">→</span>
           </a>`
        : `<span class="product-supplier">${escapeHtml(supplierLabel)}</span>`;

      card.innerHTML = `
        <div class="product-image-wrap">
          <div class="product-image-fallback">${emoji}</div>
          ${p.imageUrl ? `<img alt="${escapeAttr(p.name)}" loading="lazy" />` : ''}
          ${verified ? '<div class="product-verified" title="Real listing found via Firecrawl">✓ Verified</div>' : ''}
        </div>
        <div class="product-name">${escapeHtml(p.name)}</div>
        <span class="product-supplier">${escapeHtml(supplierLabel)}</span>
        <div class="product-desc">${escapeHtml(p.description || '')}</div>
        ${supplierLink}
        <div class="product-meta">
          <div class="product-prices">
            Cost <strong>$${fmt(p.costPrice)}</strong> · Sell <strong>$${fmt(p.sellPrice)}</strong>
          </div>
          <div class="product-margin">+${p.marginPercent}%</div>
        </div>
        ${locked ? lockOverlay(lockedCount) : ''}
      `;

      const img = card.querySelector('img');
      if (img && p.imageUrl) {
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => img.remove());
        img.src = p.imageUrl;
      }

      if (!locked) {
        card.title = 'Click to see all suppliers + deep search';
        card.addEventListener('click', (e) => {
          // Don't intercept clicks on the supplier link itself
          if (e.target.closest('a')) return;
          openProductModal(i);
        });
      }

      productGrid.appendChild(card);
    });

    // wire any unlock buttons that just got rendered
    productGrid.querySelectorAll('.lock-cta').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSubModal();
      });
    });
    // Don't let clicks on the inline supplier link bubble up to open the modal
    productGrid.querySelectorAll('.product-supplier-link').forEach((a) => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  function openProductModal(index) {
    const p = currentProducts[index];
    if (!p) return;
    openProductIndex = index;

    pmEmoji.textContent = p.emoji || '📦';
    pmName.textContent = p.name || '';
    pmChinese.textContent = p.chineseName ? `中文 · ${p.chineseName}` : '';
    pmDesc.textContent = p.description || '';
    pmCost.textContent = '$' + fmt(p.costPrice);
    pmSell.textContent = '$' + fmt(p.sellPrice);
    pmMargin.textContent = '+' + (p.marginPercent || 0) + '%';
    pmMoq.textContent = p.moqEstimate || '—';
    pmLead.textContent = p.leadTime || '—';

    pmImg.classList.remove('loaded');
    pmImg.removeAttribute('src');
    if (p.imageUrl) {
      pmImg.onload = () => pmImg.classList.add('loaded');
      pmImg.onerror = () => pmImg.classList.remove('loaded');
      pmImg.src = p.imageUrl;
    }

    pmLinks.innerHTML = '';
    if (p.realListing && p.realListing.url) {
      const a = document.createElement('a');
      a.className = 'pm-link';
      a.style.borderColor = 'var(--border-jade)';
      a.style.background = 'rgba(0,229,160,0.06)';
      a.href = p.realListing.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `
        <span class="pm-link-label">✓ Verified listing on ${escapeHtml(p.realListing.supplier || 'supplier')} <span class="arrow">→</span></span>
        <span class="pm-link-note">${escapeHtml((p.realListing.title || '').slice(0, 110))}</span>
      `;
      pmLinks.appendChild(a);
    }
    (p.links || []).forEach((l) => {
      const a = document.createElement('a');
      a.className = 'pm-link';
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = `
        <span class="pm-link-label">${escapeHtml(l.label)} <span class="arrow">→</span></span>
        <span class="pm-link-note">${escapeHtml(l.note || '')}</span>
      `;
      pmLinks.appendChild(a);
    });

    pmDeepSection.style.display = 'none';
    pmDeepBody.innerHTML = '';
    pmDeepBtn.disabled = false;
    pmDeepBtn.textContent = '✦ Run deep search';

    productModal.style.display = 'flex';
  }

  function closeProductModal() {
    productModal.style.display = 'none';
    openProductIndex = -1;
  }

  async function runDeepSearch() {
    if (openProductIndex < 0 || !currentSessionId) return;
    pmDeepBtn.disabled = true;
    pmDeepBtn.textContent = 'Searching…';
    pmDeepSection.style.display = 'block';
    pmDeepBody.innerHTML = `
      <div class="pm-deep-loading">
        <span>// Agent is sourcing this product across Chinese supplier networks…</span>
      </div>
    `;
    try {
      const data = await fetchJson('/api/deep-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          productIndex: openProductIndex,
        }),
      });
      renderDeepSearch(data);
    } catch (err) {
      pmDeepBody.innerHTML = `<div class="pm-deep-block"><strong>Deep search failed:</strong> ${escapeHtml(err.message || 'Unknown error')}</div>`;
    } finally {
      pmDeepBtn.disabled = false;
      pmDeepBtn.textContent = '✦ Run again';
    }
  }

  function renderDeepSearch(d) {
    const blocks = [];

    if (Array.isArray(d.realListings) && d.realListings.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>✦ Real product listings found</h5>
          <div class="pm-listings">
            ${d.realListings
              .map(
                (l) => `
              <a class="pm-listing" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">
                <div class="pm-listing-head">
                  <span class="pm-listing-supplier">${escapeHtml(l.supplier || 'web')}</span>
                  <span class="pm-listing-arrow">→</span>
                </div>
                <div class="pm-listing-title">${escapeHtml(l.title || l.url)}</div>
                ${l.snippet ? `<div class="pm-listing-snippet">${escapeHtml(l.snippet)}</div>` : ''}
                <div class="pm-listing-url">${escapeHtml(l.url)}</div>
              </a>`
              )
              .join('')}
          </div>
        </div>
      `);
    } else if (d.firecrawlEnabled === false) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Real product listings</h5>
          <p style="color:var(--muted);font-size:0.85rem;margin:0;">Firecrawl is not configured on the server. Add a <code>FIRECRAWL_API_KEY</code> secret to surface real product URLs here.</p>
        </div>
      `);
    }

    if (Array.isArray(d.refinedSearches) && d.refinedSearches.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Refined search queries</h5>
          ${d.refinedSearches
            .map(
              (rs, idx) => `
            <div class="pm-alt">
              <div class="pm-alt-name">${escapeHtml(rs.query)}${
                d.refinedQueriesZh && d.refinedQueriesZh[idx]
                  ? ` <span style="color:var(--jade);font-family:'IBM Plex Mono',monospace;font-size:0.85em;">· ${escapeHtml(d.refinedQueriesZh[idx])}</span>`
                  : ''
              }</div>
              <div class="pm-alt-links">
                ${rs.links
                  .map(
                    (l) => `<a class="pm-alt-link" href="${escapeAttr(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)} →</a>`
                  )
                  .join('')}
              </div>
            </div>`
            )
            .join('')}
        </div>
      `);
    }

    const specRows = (d.specifications || [])
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.spec || '')}</td><td>${escapeHtml(s.typical || '')}</td></tr>`
      )
      .join('');
    if (specRows) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Specs to request from suppliers</h5>
          <table>${specRows}</table>
        </div>
      `);
    }

    if (Array.isArray(d.alternatives) && d.alternatives.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Alternative product variants</h5>
          ${d.alternatives
            .map((alt) => {
              const en = encodeURIComponent(alt.searchEn || alt.name || '');
              const zh = encodeURIComponent(alt.searchZh || alt.searchEn || alt.name || '');
              return `
              <div class="pm-alt">
                <div class="pm-alt-name">${escapeHtml(alt.name || '')}</div>
                <div class="pm-alt-why">${escapeHtml(alt.why || '')}</div>
                <div class="pm-alt-links">
                  <a class="pm-alt-link" href="https://www.alibaba.com/trade/search?SearchText=${en}" target="_blank" rel="noopener">Alibaba →</a>
                  <a class="pm-alt-link" href="https://s.1688.com/selloffer/offer_search.htm?keywords=${zh}" target="_blank" rel="noopener">1688 →</a>
                  <a class="pm-alt-link" href="https://www.aliexpress.com/wholesale?SearchText=${en}" target="_blank" rel="noopener">AliExpress →</a>
                </div>
              </div>`;
            })
            .join('')}
        </div>
      `);
    }

    const sourcingRows = [];
    if (d.moqRange) sourcingRows.push(`<tr><td>MOQ range</td><td>${escapeHtml(d.moqRange)}</td></tr>`);
    if (d.leadTimeRange) sourcingRows.push(`<tr><td>Lead time</td><td>${escapeHtml(d.leadTimeRange)}</td></tr>`);
    if (d.samplePolicy) sourcingRows.push(`<tr><td>Sample policy</td><td>${escapeHtml(d.samplePolicy)}</td></tr>`);
    if (sourcingRows.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Sourcing terms</h5>
          <table>${sourcingRows.join('')}</table>
        </div>
      `);
    }

    if (Array.isArray(d.supplierTips) && d.supplierTips.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Supplier vetting tips</h5>
          <ul>${d.supplierTips.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        </div>
      `);
    }

    if (Array.isArray(d.qualityRisks) && d.qualityRisks.length) {
      blocks.push(`
        <div class="pm-deep-block">
          <h5>Common quality risks</h5>
          <ul>${d.qualityRisks.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        </div>
      `);
    }

    pmDeepBody.innerHTML =
      blocks.join('') ||
      `<div class="pm-deep-block">No additional sourcing data returned. Try again.</div>`;
  }

  function lockOverlay(lockedCount) {
    return `
      <div class="lock-overlay">
        <div class="lock-icon">🔒</div>
        <div class="lock-text">${lockedCount} more locked</div>
        <button class="lock-cta" type="button">Unlock all — $15/mo</button>
      </div>
    `;
  }

  function openSubModal() {
    subModal.style.display = 'flex';
  }
  function closeSubModal() {
    subModal.style.display = 'none';
  }

  function fmt(n) {
    const v = Number(n);
    if (!isFinite(v)) return '0';
    return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  exportBtn.addEventListener('click', () => {
    if (!currentSessionId) return;
    if (!isSubscribed) {
      openSubModal();
      return;
    }
    window.location.href = `/api/export/${currentSessionId}`;
  });

  // Product modal wiring
  productModalClose.addEventListener('click', closeProductModal);
  productModal.addEventListener('click', (e) => {
    if (e.target === productModal) closeProductModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && productModal.style.display === 'flex') closeProductModal();
  });
  pmDeepBtn.addEventListener('click', runDeepSearch);

  // Subscribe modal wiring
  subModalClose.addEventListener('click', closeSubModal);
  subModal.addEventListener('click', (e) => {
    if (e.target === subModal) closeSubModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && subModal.style.display === 'flex') closeSubModal();
  });
  subCtaBtn.addEventListener('click', () => {
    // Demo subscription — in production this would hand off to Stripe
    isSubscribed = true;
    localStorage.setItem(SUB_KEY, 'true');
    closeSubModal();
    // Re-render unlocked
    fetch(`/api/session/${currentSessionId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.products) renderProducts(d.products);
      })
      .catch(() => {});
  });

  addToSiteBtn.addEventListener('click', () => {
    const sid = currentSessionId || 'your-session-id';
    const origin = window.location.origin;
    const code =
      `<script src="${origin}/widget.js"\n` +
      `        data-session="${sid}"\n` +
      `        data-theme="auto"\n` +
      `        async><\/script>`;
    modalCode.textContent = code;
    modal.style.display = 'flex';
    copyHint.textContent = '';
  });

  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
  });
  function closeModal() { modal.style.display = 'none'; }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(modalCode.textContent);
      copyHint.textContent = '✓ Copied to clipboard';
    } catch {
      copyHint.textContent = 'Press Ctrl/Cmd+C to copy';
    }
  });

  // Wire the existing widget-demo buttons inside the AI panel mockup as well
  document.querySelectorAll('.ai-actions .ai-btn').forEach((btn) => {
    const label = (btn.textContent || '').trim().toLowerCase();
    if (label.includes('add to site')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        addToSiteBtn.click();
      });
    } else if (label.includes('export')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (currentSessionId) exportBtn.click();
        else input.focus();
      });
    }
  });
})();
