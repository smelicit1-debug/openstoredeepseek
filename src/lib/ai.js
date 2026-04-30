const OpenAI = require('openai');
const axios = require('axios');

let kimi = null;

function getKimi() {
  if (!kimi) {
    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) return null;
    kimi = new OpenAI({
      apiKey,
      baseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
    });
  }
  return kimi;
}

const MODEL = process.env.KIMI_MODEL || 'moonshot-v1-8k';

async function callKimi(prompt, maxTokens = 1024) {
  const client = getKimi();
  if (!client) throw new Error('KIMI_API_KEY not configured');

  const completion = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.6,
    messages: [
      {
        role: 'system',
        content:
          'You are a precise assistant. When asked for JSON, reply with valid JSON only — no prose, no code fences.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const choice = completion.choices && completion.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (!content) throw new Error('Empty response from Kimi');
  return String(content).trim();
}

/**
 * Verify that supplier listing URLs and image URLs actually load.
 * Runs all checks in parallel for speed.
 */
async function verifyProductLinks(products) {
  const checkOne = async (product) => {
    const result = { ...product, linkVerified: false, imageVerified: false, linkStatus: 'unchecked', linkTitle: '' };

    const urlsToCheck = [];
    if (product.supplierUrl) urlsToCheck.push(product.supplierUrl);
    if (!product.supplierUrl && product.realListing?.url) urlsToCheck.push(product.realListing.url);

    // Check the first valid URL
    for (const url of urlsToCheck) {
      try {
        const res = await axios.get(url, {
          timeout: 5000,
          maxRedirects: 3,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html' },
          validateStatus: (s) => s >= 200 && s < 400,
        });
        result.linkVerified = true;
        result.linkStatus = `HTTP ${res.status}`;
        const titleMatch = String(res.data).match(/<title>([^<]*)<\/title>/i);
        if (titleMatch) result.linkTitle = titleMatch[1].trim().slice(0, 120);
        break;
      } catch (err) {
        result.linkStatus = err.code === 'ENOTFOUND' ? 'domain not found' :
                           err.code === 'ECONNREFUSED' ? 'connection refused' :
                           err.response?.status ? `HTTP ${err.response.status}` : 'timeout';
      }
    }

    // Check image URL (parallel-safe, just a HEAD)
    if (product.imageUrl && !product.imageUrl.includes('pollinations.ai')) {
      try {
        const imgRes = await axios.head(product.imageUrl, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        result.imageVerified = (imgRes.headers['content-type'] || '').startsWith('image/');
      } catch { result.imageVerified = false; }
    } else {
      result.imageVerified = true; // Generated images are assumed valid
    }

    return result;
  };

  const results = await Promise.all(products.map(checkOne));
  const verified = results.filter(r => r.linkVerified).length;
  console.log(`[linkVerifier] ${verified}/${products.length} links verified`);
  return results;
}

/**
 * Review and refine AI-sourced products for quality, pricing sanity,
 * description quality, search query effectiveness, and supplier fit.
 */
async function reviewProducts(analysis, products) {
  if (!products || !products.length) return products;

  const priceRange = analysis?.priceRange;
  const priceMin = priceRange?.min ? `$${priceRange.min}` : 'unknown';
  const priceMax = priceRange?.max ? `$${priceRange.max}` : 'unknown';

  const prompt = `You are a senior product sourcing quality reviewer. Review and refine these AI-generated products to make them accurate, profitable, and actionable for a dropshipper or store owner.

Brand context:
- Brand: ${analysis?.brandName || 'Unknown'}
- Niche: ${analysis?.niche || 'Unknown'}
- Target audience: ${analysis?.targetAudience || 'Unknown'}
- Price range: ${priceMin} – ${priceMax}

For EACH product, review:
1. PRICE REALITY — Is the cost price realistic for wholesale? Is the sell price right for the brand's range (${priceMin}–${priceMax})? Margins should be 100-1500%. Adjust if unrealistic.
2. DESCRIPTION — Make it compelling and specific. One short sentence with 1 key benefit that would make someone want to buy.
3. EMOJI — Appropriate for the product? Change if wrong.
4. SEARCH QUERIES — Would the English and Chinese queries find real products on Alibaba/1688? Improve if too generic or off-target.
5. SUPPLIER FIT — apparel→1688 or Alibaba, electronics→CJ or Alibaba, accessories→any. Move products to more suitable suppliers if needed.

Current products:
${JSON.stringify(products, null, 2)}

Return ONLY a strict JSON array — same structure, same fields, with improved values. Keep ALL fields: name, emoji, costPrice, sellPrice, marginPercent, supplier, description, searchQuery, chineseName, imagePrompt, moqEstimate, leadTime. Do NOT change the number of products. Valid JSON only, no prose, no code fences.`;

  try {
    const text = await callKimi(prompt, 4096);
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    }
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1) {
      cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }
    const reviewed = JSON.parse(cleaned);
    if (!Array.isArray(reviewed) || reviewed.length === 0) {
      console.log('[reviewAgent] Invalid response, keeping original');
      return products;
    }
    // Preserve computed fields from original (id, links, supplierUrl, imageUrl, realListing)
    const merged = reviewed.map((r, i) => {
      const orig = products[i] || {};
      return {
        ...r,
        id: orig.id,
        links: orig.links,
        supplierUrl: orig.supplierUrl,
        imageUrl: orig.imageUrl,
        realListing: orig.realListing,
      };
    });
    console.log(`[reviewAgent] Reviewed ${merged.length} products ✓`);
    return merged;
  } catch (err) {
    console.error('[reviewAgent] Error:', err.message);
    return products;
  }
}

module.exports = { callKimi, getKimi, reviewProducts, verifyProductLinks };
