require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');
const cookieParser = require('cookie-parser');

const { getSupabase } = require('./src/lib/supabase');
const { requireAuth, optionalAuth, generateToken } = require('./src/lib/auth');
const { callKimi, reviewProducts } = require('./src/lib/ai');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: process.env.BASE_URL || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ─── Configuration ─────────────────────────────────────────────────
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v2';
const FREE_ANALYSES_PER_MONTH = 3;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let stripe = null;
if (STRIPE_SECRET_KEY) {
  try {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
  } catch { /* stripe not configured */ }
}

// ─── In-Memory Session Fallback (when Supabase is not configured) ──
const memorySessions = new Map();

function getSession(sessionId) {
  // Check memory first (always, even if Supabase is configured)
  const mem = memorySessions.get(sessionId);
  if (mem) return mem;
  // If Supabase is configured, the caller will fetch from DB instead
  return null;
}

function setSession(sessionId, data) {
  memorySessions.set(sessionId, data);
}

// ─── Rate / Usage Helpers ──────────────────────────────────────────
async function getUser(userId) {
  const sb = getSupabase();
  if (!sb) return { id: userId, email: '', tier: 'free', uses_this_month: 0 };
  const { data } = await sb.from('users').select('*').eq('id', userId).single();
  return data || { id: userId, email: '', tier: 'free', uses_this_month: 0 };
}

async function incrementUsage(userId) {
  const sb = getSupabase();
  if (!sb) return;
  await sb.rpc('increment_usage', { p_user_id: userId }).maybeSingle();
}

function canAnalyze(user) {
  if (user.tier === 'paid') return true;
  return (user.uses_this_month || 0) < FREE_ANALYSES_PER_MONTH;
}

// ─── Firecrawl ─────────────────────────────────────────────────────
async function firecrawlSearch(query, { limit = 5, sites = [] } = {}) {
  if (!FIRECRAWL_API_KEY) return [];
  const scoped = sites.length
    ? `${query} (${sites.map((s) => `site:${s}`).join(' OR ')})`
    : query;
  try {
    const { data } = await axios.post(
      `${FIRECRAWL_BASE}/search`,
      { query: scoped, limit },
      {
        headers: {
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    const list = data?.data?.web || data?.data || data?.results || [];
    return (Array.isArray(list) ? list : [])
      .map((r) => ({
        url: r.url || r.link || '',
        title: r.title || r.name || '',
        snippet: r.description || r.snippet || r.content || '',
      }))
      .filter((r) => r.url);
  } catch (err) {
    console.error('Firecrawl search failed:', err.response?.data?.error || err.message);
    return [];
  }
}

async function firecrawlSearchListings(query, sites, { limit = 3, scrape = false } = {}) {
  if (!FIRECRAWL_API_KEY || !query) return [];
  const scoped = sites.length
    ? `${query} (${sites.map((s) => `site:${s}`).join(' OR ')})`
    : query;
  const body = { query: scoped, limit };
  if (scrape) {
    body.scrapeOptions = { formats: ['markdown'], onlyMainContent: true };
  }
  try {
    const { data } = await axios.post(`${FIRECRAWL_BASE}/search`, body, {
      headers: {
        Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });
    const list = data?.data?.web || data?.data || [];
    return (Array.isArray(list) ? list : [])
      .map((r) => ({
        url: r.url || r.link || '',
        title: r.title || r.name || '',
        snippet: r.description || r.snippet || '',
        image:
          r.metadata?.ogImage ||
          r.metadata?.['og:image'] ||
          extractFirstImage(r.markdown || r.content || ''),
      }))
      .filter((r) => r.url);
  } catch (err) {
    console.error('Firecrawl search failed:', err.response?.data?.error || err.message);
    return [];
  }
}

function extractFirstImage(md) {
  if (!md) return '';
  const m1 = md.match(/!\[[^\]]*\]\((https?:[^\s)]+\.(?:jpe?g|png|webp)[^\s)]*)\)/i);
  if (m1) return m1[1];
  const m2 = md.match(/(https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp))/i);
  return m2 ? m2[1] : '';
}

async function findRealListing(searchEn, searchZh) {
  const enSites = ['alibaba.com', 'aliexpress.com', 'made-in-china.com', 'globalsources.com'];
  let results = await firecrawlSearchListings(searchEn, enSites, { limit: 3, scrape: true });
  let best = results.find((r) => r.image) || results[0];
  if (!best && searchZh) {
    results = await firecrawlSearchListings(searchZh, ['1688.com', 'alibaba.com'], { limit: 3, scrape: true });
    best = results.find((r) => r.image) || results[0];
  }
  if (!best) return null;
  return {
    url: best.url,
    title: best.title,
    snippet: best.snippet,
    image: best.image || '',
    supplier: classifySupplier(best.url),
  };
}

function classifySupplier(url) {
  if (!url) return 'web';
  if (url.includes('1688.com')) return '1688';
  if (url.includes('alibaba.com')) return 'Alibaba';
  if (url.includes('aliexpress.com')) return 'AliExpress';
  if (url.includes('made-in-china.com')) return 'Made-in-China';
  if (url.includes('globalsources.com')) return 'Global Sources';
  if (url.includes('cjdropshipping.com')) return 'CJ';
  if (url.includes('amazon.')) return 'Amazon';
  return 'web';
}

function normalizeUrl(input) {
  if (!input) return null;
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { return new URL(url).toString(); }
  catch { return null; }
}

// ─── Scraping ──────────────────────────────────────────────────────
function textOrEmpty($, sel) {
  return ($(sel).first().text() || '').trim();
}

function metaContent($, name) {
  return (
    $(`meta[property="${name}"]`).attr('content') ||
    $(`meta[name="${name}"]`).attr('content') ||
    ''
  ).trim();
}

function extractPrices(text) {
  const matches = text.match(/\$\s?\d{1,4}(?:[.,]\d{1,2})?/g) || [];
  const nums = matches.map((m) => parseFloat(m.replace(/[^0-9.]/g, ''))).filter((n) => !isNaN(n) && n > 0 && n < 10000);
  if (!nums.length) return null;
  nums.sort((a, b) => a - b);
  return { min: nums[0], max: nums[nums.length - 1] };
}

async function scrapeSite(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OpenStoreBot/1.0; +https://openstore.ai)',
      Accept: 'text/html,application/xhtml+xml',
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const html = res.data;
  const $ = cheerio.load(html);
  const title = textOrEmpty($, 'title');
  const ogSiteName = metaContent($, 'og:site_name');
  const description = metaContent($, 'description') || metaContent($, 'og:description') || textOrEmpty($, 'p');
  const h1 = textOrEmpty($, 'h1');
  const h2s = $('h2').slice(0, 6).map((_, el) => $(el).text().trim()).get().filter(Boolean);
  let bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  if (bodyText.length > 6000) bodyText = bodyText.slice(0, 6000);
  const productKeywords = ['shop','store','product','cart','buy','collection','sale','shipping','add to cart','checkout'];
  const lowerBody = bodyText.toLowerCase();
  const productSignals = productKeywords.filter((k) => lowerBody.includes(k));
  const priceRange = extractPrices(bodyText);
  const brandName = ogSiteName || (title.split(/[|–—-]/)[0] || '').trim() || new URL(url).hostname.replace(/^www\./, '');
  return { url, brandName, title, description, h1, headings: h2s, productSignals, detectedPriceRange: priceRange, snippet: bodyText.slice(0, 2000) };
}

function parseJson(text) {
  if (!text) throw new Error('Empty response from model');
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  if (start > 0) cleaned = cleaned.slice(start);
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBrace !== -1) cleaned = cleaned.slice(0, lastBrace + 1);
  return JSON.parse(cleaned);
}

// ─── AI: Brand Analysis ────────────────────────────────────────────
async function classifyWithClaude(scraped) {
  const prompt = `You are a brand analyst. Given the scraped data from a website, return a strict JSON object describing the brand.

Scraped data:
- URL: ${scraped.url}
- Brand name guess: ${scraped.brandName}
- Title: ${scraped.title}
- Meta description: ${scraped.description}
- H1: ${scraped.h1}
- H2s: ${(scraped.headings || []).join(' | ')}
- Product signals found: ${(scraped.productSignals || []).join(', ') || 'none'}
- Detected price range: ${scraped.detectedPriceRange ? `$${scraped.detectedPriceRange.min} - $${scraped.detectedPriceRange.max}` : 'unknown'}
- Body snippet: ${scraped.snippet}

Return ONLY valid JSON with this exact shape, no prose, no code fences:
{
  "brandName": string,
  "niche": string,
  "productTypes": string[],
  "priceRange": { "min": number, "max": number, "currency": "USD" },
  "targetAudience": string,
  "summary": string
}

Rules:
- niche should be 2-5 words (e.g. "Streetwear / urban fashion", "Premium pet supplies").
- productTypes: 3-6 short product categories the brand sells or could sell.
- priceRange.min and max in USD; if unknown, infer a plausible range.
- targetAudience: short demographic + psychographic, e.g. "18-30 urban creatives".
- summary: one short sentence.`;

  const text = await callKimi(prompt, 1024);
  return parseJson(text);
}

// ─── AI: Product Sourcing ──────────────────────────────────────────
async function sourceProducts(analysis) {
  const prompt = `You are a senior product sourcing agent for Chinese suppliers (1688, Alibaba, CJ Dropshipping). Recommend 6 to 10 products that fit this brand.

Brand analysis:
${JSON.stringify(analysis, null, 2)}

Return ONLY a strict JSON array, no prose, no code fences. Each item must have:
{
  "name": string,
  "emoji": string,
  "costPrice": number,
  "sellPrice": number,
  "marginPercent": number,
  "supplier": "1688" | "Alibaba" | "CJ",
  "description": string,
  "searchQuery": string,
  "chineseName": string,
  "imagePrompt": string,
  "moqEstimate": string,
  "leadTime": string
}

Rules:
- Sell prices must align with the brand's price range.
- Mix supplier sources across the list.
- Margins should be realistic (typically 200-800%).
- Return between 6 and 10 items.`;

  const text = await callKimi(prompt, 2048);
  const raw = parseJson(text);
  if (!Array.isArray(raw)) throw new Error('Model did not return an array');

  const candidates = raw.map((p, i) => {
    const cost = Number(p.costPrice) || 0;
    const sell = Number(p.sellPrice) || 0;
    const margin = typeof p.marginPercent === 'number' ? Math.round(p.marginPercent) : cost > 0 ? Math.round(((sell - cost) / cost) * 100) : 0;
    const supplier = ['1688', 'Alibaba', 'CJ'].includes(p.supplier) ? p.supplier : 'Alibaba';
    const name = String(p.name || 'Unnamed product');
    const searchQuery = String(p.searchQuery || name).slice(0, 120);
    const chineseName = String(p.chineseName || '').slice(0, 120);
    const imagePrompt = String(p.imagePrompt || name).slice(0, 160);
    const links = buildSupplierLinks(searchQuery, chineseName);
    const primary = links.find((l) => l.id === supplier.toLowerCase()) || links[0];
    return { _idx: i, name, emoji: String(p.emoji || '📦'), costPrice: cost, sellPrice: sell, marginPercent: margin, supplier, description: String(p.description || ''), searchQuery, chineseName, moqEstimate: String(p.moqEstimate || '50-500 pcs'), leadTime: String(p.leadTime || '15-30 days'), supplierUrl: primary.url, links, imagePrompt };
  });

  const enriched = await Promise.all(candidates.map(async (c) => {
    let listing = null;
    if (FIRECRAWL_API_KEY) {
      try { listing = await findRealListing(c.searchQuery, c.chineseName); }
      catch (err) { console.error('listing lookup failed for', c.name, err.message); }
    }
    return { c, listing };
  }));

  const final = [];
  for (const { c, listing } of enriched) {
    if (FIRECRAWL_API_KEY && !listing) { console.log(`[source] dropped "${c.name}" — no real listing`); continue; }
    const product = {
      id: final.length, name: c.name, emoji: c.emoji, costPrice: c.costPrice, sellPrice: c.sellPrice,
      marginPercent: c.marginPercent, supplier: c.supplier, description: c.description,
      searchQuery: c.searchQuery, chineseName: c.chineseName, moqEstimate: c.moqEstimate,
      leadTime: c.leadTime, supplierUrl: listing?.url || c.supplierUrl, links: c.links,
      imageUrl: listing?.image || buildImageUrl(c.imagePrompt, c._idx),
      realListing: listing || null,
    };
    final.push(product);
  }
  return final;
}

function buildSupplierLinks(q, qZh) {
  const en = encodeURIComponent(q);
  const zh = encodeURIComponent(qZh && qZh.trim() ? qZh : q);
  return [
    { id: 'alibaba', label: 'Alibaba', url: `https://www.alibaba.com/trade/search?SearchText=${en}`, note: 'Wholesale, English-language B2B' },
    { id: '1688', label: '1688 (Chinese wholesale)', url: `https://s.1688.com/selloffer/offer_search.htm?keywords=${zh}`, note: qZh ? `Searching for: ${qZh}` : 'Searches in Chinese for best results' },
    { id: 'aliexpress', label: 'AliExpress', url: `https://www.aliexpress.com/wholesale?SearchText=${en}`, note: 'Lower MOQ, ships globally' },
    { id: 'cj', label: 'CJ Dropshipping', url: `https://www.cjdropshipping.com/search?searchText=${en}`, note: 'No MOQ, dropship-ready' },
    { id: 'made-in-china', label: 'Made-in-China', url: `https://www.made-in-china.com/products-search/hot-china-products/${en}.html`, note: 'Verified manufacturers' },
    { id: 'global-sources', label: 'Global Sources', url: `https://www.globalsources.com/searchList/products?keyWord=${en}`, note: 'Verified suppliers, Hong Kong' },
    { id: 'google-shopping', label: 'Google Shopping (price ref)', url: `https://www.google.com/search?tbm=shop&q=${en}`, note: 'Compare retail prices' },
    { id: 'amazon', label: 'Amazon (retail ref)', url: `https://www.amazon.com/s?k=${en}`, note: 'Check existing retail competition' },
  ];
}

function buildImageUrl(prompt, seed) {
  const enc = encodeURIComponent(prompt + ' product photo, white background, studio lighting');
  return `https://image.pollinations.ai/prompt/${enc}?width=512&height=512&nologo=true&seed=${1000 + seed}`;
}

function newSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ─── API: Auth ─────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const sb = getSupabase();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!sb || !supabaseUrl || !anonKey) {
      // Dev mode — no Supabase, create fake user
      const user = { id: newSessionId(), email, tier: 'free', uses_this_month: 0 };
      const token = generateToken(user);
      return res.json({ token, user });
    }

    // Use Supabase Auth REST API directly
    const signupHeaders = { apikey: anonKey, 'Content-Type': 'application/json' };
    let userId;
    try {
      const signupRes = await axios.post(
        `${supabaseUrl}/auth/v1/signup`,
        { email, password },
        { headers: signupHeaders }
      );
      userId = signupRes.data?.id;
      if (!userId) throw new Error('No user ID returned');
    } catch (signupErr) {
      // If rate limited, create user directly via admin API
      const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const adminRes = await axios.post(
        `${supabaseUrl}/auth/v1/admin/users`,
        { email, password, email_confirm: true },
        { headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' } }
      );
      userId = adminRes.data?.id;
      if (!userId) throw new Error(signupErr.response?.data?.msg || 'Registration failed');
    }

    // Auto-confirm the user via admin API
    const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      await axios.put(
        `${supabaseUrl}/auth/v1/admin/users/${userId}`,
        { email_confirm: true },
        { headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}` } }
      );
    } catch { /* already confirmed */ }

    // Create user profile
    await sb.from('users').upsert({
      id: userId, email, tier: 'free', uses_this_month: 0,
      created_at: new Date().toISOString(),
    });

    const token = generateToken({ id: userId, email, tier: 'free' });
    res.json({ token, user: { id: userId, email, tier: 'free' } });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(500).json({ error: err.response?.data?.msg || err.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const sb = getSupabase();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!sb || !supabaseUrl || !anonKey) {
      // Dev mode — accept any credentials
      const user = { id: newSessionId(), email, tier: 'free', uses_this_month: 0 };
      const token = generateToken(user);
      return res.json({ token, user });
    }

    // Use Supabase Auth REST API directly
    const { data } = await axios.post(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      { email, password },
      { headers: { apikey: anonKey, 'Content-Type': 'application/json' } }
    );

    const userId = data?.user?.id;
    if (!userId) throw new Error('Invalid credentials');

    const profile = await getUser(userId);
    const token = generateToken({ id: userId, email, tier: profile.tier || 'free' });
    res.json({ token, user: { id: userId, email, tier: profile.tier || 'free', uses_this_month: profile.uses_this_month || 0 } });
  } catch (err) {
    console.error('login error:', err.message);
    const msg = err.response?.data?.error_description || err.response?.data?.msg || err.message;
    res.status(401).json({ error: msg || 'Login failed.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  res.json({ user: { id: user.id, email: user.email, tier: user.tier || 'free', uses_this_month: user.uses_this_month || 0 } });
});

// ─── API: Billing ──────────────────────────────────────────────────
app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.BASE_URL || 'http://localhost:5000'}/dashboard?checkout=success`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:5000'}/dashboard?checkout=cancel`,
      client_reference_id: req.user.id,
      customer_email: req.user.email,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

app.get('/api/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured.' });

  try {
    const sb = getSupabase();
    let stripeCustomerId = null;
    if (sb) {
      const { data } = await sb.from('users').select('stripe_customer_id').eq('id', req.user.id).single();
      stripeCustomerId = data?.stripe_customer_id;
    }
    if (!stripeCustomerId) return res.status(404).json({ error: 'No billing record found.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.BASE_URL || 'http://localhost:5000'}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('portal error:', err.message);
    res.status(500).json({ error: 'Failed to create portal session.' });
  }
});

// Stripe webhook
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Billing not configured.' });

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const sb = getSupabase();
  if (!sb) return res.json({ received: true });

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const customerId = session.customer;
      const subId = session.subscription;
      // Update user to paid tier
      await sb.from('users').upsert({ id: userId, tier: 'paid', stripe_customer_id: customerId, stripe_subscription_id: subId, updated_at: new Date().toISOString() });
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { data } = await sb.from('users').select('id').eq('stripe_subscription_id', sub.id).single();
      if (data) {
        await sb.from('users').upsert({ id: data.id, tier: 'free', stripe_subscription_id: null, updated_at: new Date().toISOString() });
      }
    }
  } catch (err) {
    console.error('webhook handler error:', err.message);
  }

  res.json({ received: true });
});

// ─── API: Analyze ──────────────────────────────────────────────────
app.post('/api/analyze', optionalAuth, async (req, res) => {
  try {
    const url = normalizeUrl(req.body && req.body.url);
    if (!url) return res.status(400).json({ error: 'A valid URL is required.' });

    // Check usage for authenticated users
    if (req.user) {
      const user = await getUser(req.user.id);
      if (!canAnalyze(user)) {
        return res.status(403).json({ error: `Free limit reached (${FREE_ANALYSES_PER_MONTH}/month). Upgrade to continue.` });
      }
    }

    const scraped = await scrapeSite(url);
    const analysis = await classifyWithClaude(scraped);

    const sessionId = newSessionId();

    // Save to memory (or Supabase if configured)
    const sessionData = { url, analysis, products: null, created_at: new Date().toISOString() };
    setSession(sessionId, sessionData);

    const sb = getSupabase();
    if (sb && req.user) {
      await sb.from('sessions').insert({
        id: sessionId, user_id: req.user.id, url, analysis, created_at: new Date().toISOString()
      });
      await incrementUsage(req.user.id);
    }

    res.json({ sessionId, analysis });
  } catch (err) {
    console.error('analyze error:', err.message);
    const status = err.response?.status;
    let msg = err.message || 'Failed to analyze site.';
    if (status === 403 || status === 401) msg = 'That site blocks automated requests. Try another URL.';
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') msg = 'Could not reach that site.';
    res.status(500).json({ error: msg });
  }
});

// ─── API: Source Products ──────────────────────────────────────────
app.post('/api/source', optionalAuth, async (req, res) => {
  try {
    const { sessionId, analysis } = req.body || {};
    let workingAnalysis = analysis;

    // Try loading analysis from memory or DB
    if (!workingAnalysis && sessionId) {
      // Check memory first
      const mem = getSession(sessionId);
      if (mem && mem.analysis) {
        workingAnalysis = mem.analysis;
      } else {
        // Then try Supabase
        const sb = getSupabase();
        if (sb) {
          const { data } = await sb.from('sessions').select('analysis, user_id').eq('id', sessionId).single();
          if (data) {
            workingAnalysis = data.analysis;
          }
        }
      }
    }

    if (!workingAnalysis) return res.status(400).json({ error: 'Brand analysis is required. Run /api/analyze first.' });

    const products = await sourceProducts(workingAnalysis);
    if (!products.length) {
      return res.status(502).json({ error: 'No verifiable supplier listings were found for this brand. Try a different URL or rerun in a moment.' });
    }

    // Save products to memory or DB
    if (sessionId) {
      const mem = getSession(sessionId);
      if (mem) {
        mem.products = products;
        mem.updated_at = new Date().toISOString();
        setSession(sessionId, mem);
      }
    }

    let sid = sessionId;
    const sb = getSupabase();
    if (sb && sessionId) {
      await sb.from('sessions').update({ products, updated_at: new Date().toISOString() }).eq('id', sessionId);
    } else {
      sid = newSessionId();
      if (sb && req.user) {
        await sb.from('sessions').insert({ id: sid, user_id: req.user.id, analysis: workingAnalysis, products, created_at: new Date().toISOString() });
      }
    }

    // Run review agent to improve product quality
    try {
      products = await reviewProducts(workingAnalysis, products);
    } catch (err) {
      console.error('[reviewAgent] failed, using original:', err.message);
    }

    res.json({ sessionId: sid, products });
  } catch (err) {
    console.error('source error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to source products.' });
  }
});

// ─── API: Deep Search ──────────────────────────────────────────────
app.post('/api/deep-search', optionalAuth, async (req, res) => {
  try {
    const { sessionId, productIndex } = req.body || {};
    if (!sessionId || productIndex === undefined) return res.status(400).json({ error: 'sessionId and productIndex required.' });

    let product, analysis;
    // Check memory first
    const mem = getSession(sessionId);
    if (mem) {
      product = mem.products?.[Number(productIndex)];
      analysis = mem.analysis;
    } else {
      const sb = getSupabase();
      if (sb) {
        const { data } = await sb.from('sessions').select('products, analysis').eq('id', sessionId).single();
        if (!data) return res.status(404).json({ error: 'Session not found.' });
        product = data.products?.[Number(productIndex)];
        analysis = data.analysis;
      }
    }

    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const prompt = `You are a senior China-sourcing agent. A buyer wants to deep-source this product. Return ONLY a strict JSON object — no prose, no code fences.

Product:
${JSON.stringify({ name: product.name, description: product.description, chineseName: product.chineseName, sellPrice: product.sellPrice, costPrice: product.costPrice }, null, 2)}

Brand context:
${JSON.stringify(analysis || {}, null, 2)}

Return JSON with this exact shape:
{
  "refinedQueriesEn": string[],
  "refinedQueriesZh": string[],
  "specifications": [{ "spec": string, "typical": string }],
  "alternatives": [{ "name": string, "why": string, "searchEn": string, "searchZh": string }],
  "supplierTips": string[],
  "moqRange": string,
  "leadTimeRange": string,
  "samplePolicy": string,
  "qualityRisks": string[]
}`;

    const text = await callKimi(prompt, 2048);
    const data = parseJson(text);

    const queries = (data.refinedQueriesEn || []).map((q, i) => ({
      query: q,
      links: buildSupplierLinks(q, (data.refinedQueriesZh || [])[i] || ''),
    }));

    let realListings = [];
    let firecrawlEnabled = !!FIRECRAWL_API_KEY;
    if (firecrawlEnabled) {
      const enQueries = (data.refinedQueriesEn || []).slice(0, 2);
      const zhQueries = (data.refinedQueriesZh || []).slice(0, 1);
      const supplierSites = ['alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com', 'aliexpress.com'];
      const searchTasks = [
        ...enQueries.map((q) => ({ query: q, opts: { sites: supplierSites, limit: 5 } })),
        ...zhQueries.map((q) => ({ query: q, opts: { sites: ['1688.com', 'alibaba.com'], limit: 5 } })),
      ];
      const results = await Promise.all(searchTasks.map((t) =>
        firecrawlSearch(t.query, t.opts).then((items) => ({ query: t.query, items }))
      ));
      const seen = new Set();
      for (const r of results) {
        for (const it of r.items) {
          if (!it.url || seen.has(it.url)) continue;
          seen.add(it.url);
          realListings.push({ url: it.url, title: it.title || it.url, snippet: (it.snippet || '').slice(0, 220), supplier: classifySupplier(it.url), matchedQuery: r.query });
        }
      }
      const rank = { '1688': 0, Alibaba: 1, AliExpress: 2, 'Made-in-China': 3, 'Global Sources': 4, CJ: 5, Amazon: 6, web: 7 };
      realListings.sort((a, b) => (rank[a.supplier] ?? 9) - (rank[b.supplier] ?? 9));
      realListings = realListings.slice(0, 12);
    }

    res.json({ productId: product.id, productName: product.name, ...data, refinedSearches: queries, realListings, firecrawlEnabled });
  } catch (err) {
    console.error('deep-search error:', err.message);
    res.status(500).json({ error: err.message || 'Deep search failed.' });
  }
});

// ─── API: Session ──────────────────────────────────────────────────
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    // Check memory first
    const mem = getSession(req.params.sessionId);
    if (mem) return res.json({ sessionId: req.params.sessionId, analysis: mem.analysis || null, products: mem.products || [] });

    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('sessions').select('*').eq('id', req.params.sessionId).single();
      if (data) return res.json({ sessionId: req.params.sessionId, analysis: data.analysis || null, products: data.products || [] });
    }
    res.status(404).json({ error: 'Session not found.' });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// ─── API: Export ───────────────────────────────────────────────────
app.get('/api/export/:sessionId', requireAuth, async (req, res) => {
  try {
    // Check user tier
    const user = await getUser(req.user.id);
    if (user.tier !== 'paid') return res.status(403).json({ error: 'Export requires a paid subscription.' });

    let sessionData;
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb.from('sessions').select('*').eq('id', req.params.sessionId).single();
      sessionData = data;
    }
    if (!sessionData || !sessionData.products) return res.status(404).json({ error: 'Session not found or no products to export.' });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'OpenStore.ai';
    wb.created = new Date();
    const ws = wb.addWorksheet('Sourced Products');
    ws.columns = [
      { header: 'Product', key: 'name', width: 32 }, { header: 'Chinese name (1688)', key: 'chineseName', width: 28 },
      { header: 'Cost (USD)', key: 'costPrice', width: 12 }, { header: 'Sell (USD)', key: 'sellPrice', width: 12 },
      { header: 'Margin %', key: 'marginPercent', width: 11 },
      { header: 'MOQ', key: 'moqEstimate', width: 14 }, { header: 'Lead time', key: 'leadTime', width: 14 },
      { header: 'Description', key: 'description', width: 50 }, { header: 'Image URL', key: 'imageUrl', width: 50 },
      { header: '1688 (中文)', key: 'url1688', width: 50 }, { header: 'Alibaba', key: 'urlAlibaba', width: 50 },
      { header: 'AliExpress', key: 'urlAli', width: 50 }, { header: 'CJ Dropshipping', key: 'urlCJ', width: 50 },
      { header: 'Made-in-China', key: 'urlMIC', width: 50 }, { header: 'Global Sources', key: 'urlGS', width: 50 },
      { header: 'Google Shopping', key: 'urlGoogle', width: 50 }, { header: 'Amazon (retail)', key: 'urlAmazon', width: 50 },
    ];
    ws.getRow(1).font = { bold: true };
    sessionData.products.forEach((p) => {
      const byId = (id) => (p.links || []).find((l) => l.id === id)?.url || '';
      ws.addRow({ ...p, url1688: byId('1688'), urlAlibaba: byId('alibaba'), urlAli: byId('aliexpress'), urlCJ: byId('cj'), urlMIC: byId('made-in-china'), urlGS: byId('global-sources'), urlGoogle: byId('google-shopping'), urlAmazon: byId('amazon') });
    });

    const filename = `openstore-${req.params.sessionId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('export error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to export.' });
  }
});

// ─── API: Usage ────────────────────────────────────────────────────
app.get('/api/usage', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  res.json({ tier: user.tier || 'free', uses_this_month: user.uses_this_month || 0, limit: FREE_ANALYSES_PER_MONTH });
});

// ─── API: Health ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ─── Serve Frontend & Static Files ─────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res) => {
    if (process.env.NODE_ENV !== 'production') res.setHeader('Cache-Control', 'no-store');
  },
}));

// SPA fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenStore.ai running on http://0.0.0.0:${PORT}`);
  console.log(`  AI: ${process.env.KIMI_API_KEY ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Firecrawl: ${FIRECRAWL_API_KEY ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Supabase: ${process.env.NEXT_PUBLIC_SUPABASE_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  Stripe: ${STRIPE_SECRET_KEY ? 'configured' : 'NOT CONFIGURED'}`);
});
