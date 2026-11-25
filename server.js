// 99 Shop — Facebook Messenger webhook server (free-tier friendly)
// Receives Page messages, answers from the e99shop.com catalog, takes orders.
// Catalog source: the shop's own public backend API (same source the chatbot uses).
// No database: orders are kept in orders.json (+ shown on /orders). On Render's
// free tier the disk is ephemeral, so check /orders regularly.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'changeme-verify-token';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-admin';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Models tried in order. Free-tier Flash models overload often (HTTP 503), so
// the server tries each model once and moves to the next — never waits long on
// an overloaded model. Lite first: it is the reliable one right now and has the
// bigger free quota (500 calls/day vs ~20 for 3.8-flash).
const GEMINI_MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite,gemini-3.8-flash').split(',').map(s => s.trim()).filter(Boolean);
const VERSION = '1.2-switch';
const BOT_STATE_FILE = path.join(__dirname, 'bot-state.json');
const API_BASE = 'https://backend.e99shop.com/api/v2/products';
const GRAPH_API = 'https://graph.facebook.com/v21.0/me/messages';
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const UNANSWERED_FILE = path.join(__dirname, 'unanswered.json');
const CACHE_FILE = path.join(__dirname, 'catalog-cache.json');

// ---- Shop facts (confirmed by the owner) ----
const SHOP = {
  name: '99 Shop Bangladesh',
  phone: '01918107441',
  deliveryDhaka: 80,
  deliverySubDhaka: 110,
  deliveryOutside: 140,
  freeDeliveryAbove: 2000,
  deliveryDays: 'ঢাকায় ১-২ দিন, ঢাকার বাইরে ১-৪ দিন',
};
const SUB_DHAKA = ['savar', 'সাভার', 'keraniganj', 'কেরানীগঞ্জ', 'keranigonj',
  'narayanganj', 'নারায়ণগঞ্জ', 'gazipur', 'গাজীপুর', 'tongi', 'টঙ্গী'];

// ---------------- Bot on/off switch (owner control) ----------------
// When off, the bot stays completely SILENT: it still answers Meta's webhook
// with 200 (so nothing breaks), but it sends no reply at all — not even an
// "offline" message. State lives in bot-state.json (default: on).
let BOT_ENABLED = true;
try {
  const st = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
  if (typeof st.enabled === 'boolean') BOT_ENABLED = st.enabled;
} catch { /* no state file yet — default on */ }
function saveBotState() {
  try { fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({ enabled: BOT_ENABLED })); } catch (e) { console.error('bot state save failed', e.message); }
}

// ---------------- Catalog ----------------
let CATALOG = []; // {id,name,price,compareAt,category,image,stock}
let catalogLoadedAt = null;

async function fetchPage(page) {
  const url = `${API_BASE}?page=${page}&limit=100`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`API page ${page} -> HTTP ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

async function loadCatalog() {
  const byName = new Map();
  for (let p = 1; p <= 10; p++) {
    let items = [];
    try { items = await fetchPage(p); } catch (e) { console.error('catalog fetch failed page', p, e.message); }
    for (const it of items) {
      const price = Math.round(Number(it.main_price) || 0);
      const compareAt = it.has_discount ? Math.round(Number(it.stroked_price) || 0) : 0;
      const stock = Number(it.current_stock ?? it.stock ?? 0);
      const name = String(it.name || '').trim();
      if (!name) continue;
      const prod = {
        id: it.id, name, price,
        compareAt: compareAt > price ? compareAt : 0,
        category: String(it.category_name || '').trim(),
        image: String(it.thumbnail_image || '').trim(),
        stock,
      };
      const key = name.toLowerCase();
      const prev = byName.get(key);
      // dedupe: keep the priced copy; skip ৳0 duplicates
      if (!prev) byName.set(key, prod);
      else if (prev.price === 0 && prod.price > 0) byName.set(key, prod);
    }
    if (items.length < 100) break;
  }
  CATALOG = [...byName.values()];
  catalogLoadedAt = new Date();
  console.log(`catalog loaded: ${CATALOG.length} products`);
  // Save a snapshot so a cold start (after the free host sleeps) can answer
  // instantly from the cache while the fresh catalog loads in the background.
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(CATALOG)); } catch (e) { console.error('catalog cache write failed', e.message); }
}

// Load the cached snapshot at startup (if any) so the bot can answer before
// the first live API fetch finishes.
function loadCatalogCache() {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(data) && data.length > 100) {
      CATALOG = data;
      catalogLoadedAt = new Date();
      console.log(`catalog loaded from cache: ${CATALOG.length} products`);
      return true;
    }
  } catch { /* no usable cache — the live load below fills the catalog */ }
  return false;
}
setInterval(() => { loadCatalog().catch(e => console.error('catalog refresh failed', e.message)); }, 6 * 60 * 60 * 1000);

// ---------------- Text helpers ----------------
const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
function toLatinDigits(s) { return String(s).replace(/[০-৯]/g, d => BN_DIGITS[d]); }
function normalize(s) {
  return toLatinDigits(String(s || '').toLowerCase())
    .replace(/[।.,!?;:()"'`]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// strip common Bengali inflection suffixes so "লিপ লাইনারের" matches "লিপ লাইনার"
function stripSuffixes(word) {
  return word
    .replace(/(গুলো|গুলি|গুলা|দের|টা|টি|খানা|খানি)$/, '')
    .replace(/(ের|কে|তে|এ|য়|ই|ও)$/, '');
}
function tokensOf(s) {
  return normalize(s).split(' ').filter(Boolean).map(stripSuffixes).filter(Boolean);
}

// Bengali / Banglish words -> English concept tokens used in product names & categories
const CONCEPTS = [
  { words: ['earring', 'earrings', 'দুল', 'কানেরদুল', 'কানের', 'ঝুমকা', 'jhumka', 'chandbali'], concept: 'earring' },
  { words: ['lip liner', 'লিপলাইনার', 'লিপ লাইনার', 'lipliner'], concept: 'lip liner' },
  { words: ['eyeliner', 'আইলাইনার', 'eye liner'], concept: 'eyeliner' },
  { words: ['lipstick', 'লিপস্টিক', 'লিপিষ্টিক'], concept: 'lipstick' },
  { words: ['lip gloss', 'লিপগ্লস', 'লিপ গ্লস'], concept: 'lip gloss' },
  { words: ['lip balm', 'লিপবাম', 'লিপ বাম'], concept: 'lip balm' },
  { words: ['bag', 'ব্যাগ', 'হ্যান্ডব্যাগ', 'handbag', 'purse', 'পার্স'], concept: 'bag' },
  { words: ['watch', 'ঘড়ি', 'ঘড়ি'], concept: 'watch' },
  { words: ['necklace', 'নেকলেস', 'হার', 'চেইন', 'chain', 'pendant'], concept: 'necklace' },
  { words: ['ring', 'আংটি', 'আংটির', 'finger ring'], concept: 'ring' },
  { words: ['bangle', 'bracelet', 'চুড়ি', 'চুড়ি', 'ব্রেসলেট'], concept: 'bracelet' },
  { words: ['kajal', 'কাজল', 'কাজল'], concept: 'kajal' },
  { words: ['mascara', 'মাস্কারা'], concept: 'mascara' },
  { words: ['foundation', 'ফাউন্ডেশন'], concept: 'foundation' },
  { words: ['cream', 'ক্রিম'], concept: 'cream' },
  { words: ['shampoo', 'শ্যাম্পু'], concept: 'shampoo' },
  { words: ['perfume', 'পারফিউম', 'fragrance'], concept: 'perfume' },
  { words: ['sunglass', 'sunglasses', 'সানগ্লাস'], concept: 'sunglass' },
  { words: ['nail polish', 'নেইলপলিশ', 'নেইল পলিশ'], concept: 'nail polish' },
  { words: ['makeup', 'মেকআপ', 'মেক আপ'], concept: 'makeup' },
  { words: ['jewellery', 'jewelry', 'জুয়েলারি', 'গহনা'], concept: 'jewellery' },
  { words: ['hair', 'চুল', 'হেয়ার'], concept: 'hair' },
  { words: ['baby', 'বেবি', 'শিশু'], concept: 'baby' },
  { words: ['kitchen', 'রান্নাঘর'], concept: 'kitchen' },
  { words: ['candle', 'মোমবাতি'], concept: 'candle' },
  { words: ['blanket', 'কম্বল'], concept: 'blanket' },
  { words: ['bottle', 'বোতল'], concept: 'bottle' },
  { words: ['toy', 'খেলনা'], concept: 'toy' },
  { words: ['chocolate', 'চকলেট'], concept: 'chocolate' },
];

function findConcept(text) {
  const norm = ' ' + normalize(text) + ' ';
  for (const c of CONCEPTS) {
    for (const w of c.words) {
      const nw = ' ' + normalize(w) + ' ';
      if (norm.includes(nw)) return c.concept;
    }
  }
  return null;
}

// concept -> words to match against product names/categories (whole-word)
function conceptWords(concept) {
  const entry = CONCEPTS.find(c => c.concept === concept);
  if (!entry) return [concept];
  return entry.words.map(w => normalize(w)).filter(Boolean);
}

// token match that tolerates singular/plural ('earring' matches 'earrings' and back)
function hasToken(hay, t) {
  if (hay.includes(t)) return true;
  if (t.endsWith('s') && hay.includes(t.slice(0, -1))) return true;
  if (hay.includes(t + 's')) return true;
  return false;
}

function productSearchTokens(p) {
  return tokensOf(p.name + ' ' + p.category);
}

// score: whole-word concept matches rank first; then any query token matches
function searchProducts(query, maxPrice) {
  const concept = findConcept(query);
  const qTokens = tokensOf(query);
  const scored = [];
  for (const p of CATALOG) {
    if (p.stock <= 0) continue;
    if (maxPrice != null && p.price > maxPrice) continue;
    // Concept words match against the NAME only — the category token used to
    // inflate scores (e.g. every earring got +10 twice via category "Earrings").
    const nameHay = tokensOf(p.name);
    const catHay = tokensOf(p.category);
    let score = 0;
    if (concept) {
      for (const cw of conceptWords(concept)) {
        const cTokens = cw.split(' ');
        if (cTokens.every(t => hasToken(nameHay, t))) score += 10;
        else if (cTokens.some(t => hasToken(nameHay, t))) score += 4;
      }
      // category match is a strong signal (e.g. category "Lip Liner")
      if (catHay.join(' ').includes(concept)) score += 6;
    }
    for (const t of qTokens) {
      if (t.length > 2 && (hasToken(nameHay, t) || hasToken(catHay, t))) score += 2;
    }
    if (score > 0) scored.push({ p, score });
  }
  // When the question names a concept (e.g. lip liner), only keep products
  // that really match that concept — loose token matches (lipstick, lip gloss...)
  // inflate the "more designs" count with the wrong items. A category-only
  // match scores 6 and counts: a product whose only signal is its category
  // (e.g. a photo album in Women's Bag) is genuinely in that category.
  const filtered = concept ? scored.filter(s => s.score >= 6) : scored;
  filtered.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return filtered.map(s => s.p);
}

function extractBudget(text) {
  const t = toLatinDigits(text);
  const m = t.match(/(\d[\d,]*)\s*(টাকার?|tk|taka)?\s*(মধ্যে|এর মধ্যে|ভিতরে|নিচে|কম)?/);
  if (!m) return null;
  if (/মধ্যে|এর মধ্যে|ভিতরে|নিচে|কম|টাকার/.test(t) || /taka|tk/.test(t.toLowerCase())) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 50 && n <= 100000) return n;
  }
  return null;
}

function fmtPrice(p) {
  return p.compareAt ? `${p.price} টাকা (আগের দাম ${p.compareAt} টাকা)` : `${p.price} টাকা`;
}

// ---------------- Sessions (per Facebook sender) ----------------
const sessions = new Map(); // psid -> {state, items:[{product,qty}], lastList:[products], name, phone, address, area}
function sessionFor(psid) {
  if (!sessions.has(psid)) sessions.set(psid, { state: 'idle', items: [], lastList: [], suggested: false });
  return sessions.get(psid);
}

// ---------------- Orders storage ----------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function appendJson(file, row) {
  const arr = readJson(file, []);
  arr.push(row);
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

function deliveryFor(addressText) {
  const t = normalize(addressText || '');
  if (/(^| )ঢাকা( |$)|dhaka/.test(' ' + t + ' ') && !SUB_DHAKA.some(a => t.includes(normalize(a)))) return { zone: 'dhaka', charge: SHOP.deliveryDhaka };
  if (SUB_DHAKA.some(a => t.includes(normalize(a)))) return { zone: 'sub_dhaka', charge: SHOP.deliverySubDhaka };
  // "ঢাকা" with no sub-area => Dhaka; anything else => outside
  if (t.includes('ঢাকা') || t.includes('dhaka')) return { zone: 'dhaka', charge: SHOP.deliveryDhaka };
  return { zone: 'outside', charge: SHOP.deliveryOutside };
}

// ---------------- Soft upsell (one gentle suggestion per order) ----------------
// Rules the owner set: suggest at most ONE matching product, once per order,
// right before confirmation. "না" (or ignoring it) ends it for that order —
// the bot never suggests twice in one conversation and never pushes.
const PAIRINGS = [
  { from: 'earring', suggest: 'necklace' },
  { from: 'necklace', suggest: 'earring' },
  { from: 'lip liner', suggest: 'lipstick' },
  { from: 'lipstick', suggest: 'lip liner' },
  { from: 'eyeliner', suggest: 'mascara' },
  { from: 'mascara', suggest: 'eyeliner' },
  { from: 'kajal', suggest: 'eyeliner' },
  { from: 'ring', suggest: 'bracelet' },
  { from: 'bracelet', suggest: 'ring' },
  { from: 'bag', suggest: 'perfume' },
  { from: 'watch', suggest: 'bracelet' },
  { from: 'foundation', suggest: 'cream' },
  { from: 'cream', suggest: 'foundation' },
  { from: 'shampoo', suggest: 'cream' },
  { from: 'nail polish', suggest: 'lipstick' },
  { from: 'makeup', suggest: 'lipstick' },
  { from: 'lip gloss', suggest: 'lipstick' },
  { from: 'lip balm', suggest: 'lip gloss' },
];

function pickSuggestion(items) {
  const ordered = new Set(items.map(i => i.product.name.toLowerCase()));
  for (const it of items) {
    const concept = findConcept(it.product.name + ' ' + it.product.category);
    const pairing = PAIRINGS.find(p => p.from === concept);
    if (!pairing) continue;
    const cands = searchProducts(pairing.suggest, null)
      .filter(p => p.stock > 0 && !ordered.has(p.name.toLowerCase()));
    if (cands.length) return cands[0];
  }
  // fallback: cheapest in-stock item from the same category as the first item
  const first = items[0];
  if (first) {
    const cands = CATALOG
      .filter(p => p.stock > 0 && p.category === first.product.category && !ordered.has(p.name.toLowerCase()))
      .sort((a, b) => a.price - b.price);
    if (cands.length) return cands[0];
  }
  return null;
}

function computeTotals(s) {
  const subtotal = s.items.reduce((a, i) => a + i.product.price * i.qty, 0);
  const delivery = subtotal >= SHOP.freeDeliveryAbove ? 0 : (s.zoneCharge || 0);
  s.deliveryCharge = delivery;
  return { subtotal, delivery, total: subtotal + delivery };
}

function orderSummaryText(s) {
  const { subtotal, delivery, total } = computeTotals(s);
  const lines = s.items.map(i => `• ${i.product.name} × ${i.qty} — ${i.product.price * i.qty} টাকা`).join('\n');
  return `অর্ডারের বিবরণ:\n${lines}\nপণ্যের মোট: ${subtotal} টাকা\nডেলিভারি চার্জ: ${delivery === 0 ? 'ফ্রি' : delivery + ' টাকা'}\nসর্বমোট: ${total} টাকা\nনাম: ${s.name}\nফোন: ${s.phone}\nঠিকানা: ${s.address}`;
}

function finalizeOrder(s, psid) {
  const { subtotal, delivery, total } = computeTotals(s);
  const order = {
    id: 'ORD-' + Date.now().toString(36).toUpperCase(),
    time: new Date().toISOString(),
    psid,
    items: s.items.map(i => ({ name: i.product.name, price: i.product.price, qty: i.qty })),
    subtotal, delivery, total,
    name: s.name, phone: s.phone, address: s.address, area: s.area,
    status: 'নতুন',
  };
  appendJson(ORDERS_FILE, order);
  const oid = order.id;
  sessions.set(psid, { state: 'idle', items: [], lastList: [], suggested: false });
  return {
    text: `অর্ডার কনফার্ম হয়েছে! 🎉\nঅর্ডার নম্বর: ${oid}\nসর্বমোট: ${total} টাকা (ক্যাশ অন ডেলিভারি)\n${SHOP.deliveryDays}-এর মধ্যে পৌঁছে যাবে। কোনো প্রয়োজনে কল করুন: ${SHOP.phone}`,
    images: [],
  };
}

// ---------------- Reply brain ----------------
// returns {text, images:[{url,name}]} — images are product photos to attach
function brain(psid, rawText) {
  const text = String(rawText || '').trim();
  const s = sessionFor(psid);
  const norm = normalize(text);

  // ---- order flow states ----
  if (s.state === 'awaiting_qty') {
    const q = parseInt(toLatinDigits(text).replace(/[^0-9]/g, ''), 10);
    if (q >= 1 && q <= 20) {
      s.items[s.items.length - 1].qty = q;
      s.state = 'awaiting_name';
      return { text: `ঠিক আছে, ${q}টা। অর্ডারের জন্য আপনার নামটা লিখুন।`, images: [] };
    }
    return { text: 'কয়টা নেবেন, সংখ্যায় লিখুন (যেমন: ২)।', images: [] };
  }
  if (s.state === 'awaiting_name') {
    s.name = text; s.state = 'awaiting_phone';
    return { text: `ধন্যবাদ, ${text}। এবার আপনার মোবাইল নম্বরটা দিন।`, images: [] };
  }
  if (s.state === 'awaiting_phone') {
    const phone = toLatinDigits(text).replace(/[^0-9+]/g, '');
    if (phone.length >= 11) {
      s.phone = phone; s.state = 'awaiting_address';
      return { text: 'এবার পুরো ঠিকানাটা লিখুন (বাসা/রোড, এলাকা, জেলা)।', images: [] };
    }
    return { text: 'সঠিক মোবাইল নম্বরটা আবার দিন (১১ সংখ্যার)।', images: [] };
  }
  if (s.state === 'awaiting_address') {
    s.address = text;
    const d = deliveryFor(text);
    s.area = d.zone;
    s.zoneCharge = d.charge;
    // Soft upsell: at most once per order, one matching product, easy to refuse.
    if (!s.suggested) {
      const sug = pickSuggestion(s.items);
      if (sug) {
        s.suggested = true;
        s.suggestedProduct = sug;
        s.state = 'awaiting_suggestion';
        return {
          text: `${orderSummaryText(s)}\n\nএকটা ছোট সাজেশন — ${sug.name} (${fmtPrice(sug)}) আপনার অর্ডারের সাথে ভালো মানাবে, অনেকেই একসাথে নেন। যোগ করবো? "হ্যাঁ" লিখলে যোগ হয়ে যাবে। আর কিছু যোগ করতে চাইলে প্রোডাক্টের নাম লিখুন, না হলে "কনফার্ম" লিখুন।`,
          images: sug.image ? [{ url: sug.image, name: sug.name }] : [],
        };
      }
    }
    s.state = 'awaiting_confirm';
    return {
      text: `${orderSummaryText(s)}\n\nসব ঠিক থাকলে "কনফার্ম" লিখুন।`,
      images: [],
    };
  }
  if (s.state === 'awaiting_suggestion') {
    const sug = s.suggestedProduct;
    // "হ্যাঁ" -> add the suggested product (qty 1), then show updated summary
    if (/^(হ্যাঁ|হ্যা|yes|যোগ করো|যোগ করুন|নেবো|নেব|নিতে চাই|ঠিক আছে|ok|okay)/.test(norm)) {
      if (sug) s.items.push({ product: sug, qty: 1 });
      s.suggestedProduct = null;
      s.state = 'awaiting_confirm';
      return { text: `${orderSummaryText(s)}\n\nসব ঠিক থাকলে "কনফার্ম" লিখুন।`, images: [] };
    }
    // "কনফার্ম" -> confirm the order right away (no extra step)
    if (/^(কনফার্ম|confirm)/.test(norm)) {
      return finalizeOrder(s, psid);
    }
    // "বাতিল" -> cancel
    if (/^(বাতিল|cancel)/.test(norm)) {
      sessions.set(psid, { state: 'idle', items: [], lastList: [], suggested: false });
      return { text: 'ঠিক আছে, অর্ডারটি বাতিল করা হলো। আর কিছু লাগলে জানাবেন।', images: [] };
    }
    // "না" -> skip the suggestion, show summary for confirmation
    if (/^(না|no|লাগবে না|দরকার নেই|থাক)/.test(norm)) {
      s.suggestedProduct = null;
      s.state = 'awaiting_confirm';
      return { text: `${orderSummaryText(s)}\n\nসব ঠিক থাকলে "কনফার্ম" লিখুন।`, images: [] };
    }
    // a product name -> add that product (qty 1) instead
    const hits = searchProducts(text, null);
    if (hits.length) {
      const prod = hits[0];
      const already = s.items.some(i => i.product.name === prod.name);
      if (!already) s.items.push({ product: prod, qty: 1 });
      s.suggestedProduct = null;
      s.state = 'awaiting_confirm';
      return { text: `${already ? 'এই প্রোডাক্টটা অর্ডারে আগেই আছে।' : prod.name + ' যোগ করা হলো।'}\n${orderSummaryText(s)}\n\nসব ঠিক থাকলে "কনফার্ম" লিখুন।`, images: prod.image ? [{ url: prod.image, name: prod.name }] : [] };
    }
    return { text: 'সাজেশনটা যোগ করতে "হ্যাঁ" লিখুন, আর কিছু যোগ করতে চাইলে প্রোডাক্টের নাম লিখুন। অর্ডার শেষ করতে "কনফার্ম" লিখুন।', images: [] };
  }
  if (s.state === 'awaiting_confirm') {
    if (/^(কনফার্ম|confirm|হ্যাঁ|হ্যা|yes|ঠিক আছে|ok)/.test(norm)) {
      return finalizeOrder(s, psid);
    }
    if (/^(না|no|বাতিল|cancel)/.test(norm)) {
      sessions.set(psid, { state: 'idle', items: [], lastList: [], suggested: false });
      return { text: 'ঠিক আছে, অর্ডারটি বাতিল করা হলো। আর কিছু লাগলে জানাবেন।', images: [] };
    }
    return { text: 'কনফার্ম করতে "কনফার্ম" লিখুন, আর বাতিল করতে "বাতিল" লিখুন।', images: [] };
  }

  // ---- greetings ----
  if (/^(সালাম|আসসালামু|আসসালাম|হাই|হ্যালো|hello|hi|hey|আদাব|নমস্কার)/.test(norm)) {
    return { text: `আসসালামু আলাইকুম! 😊 ${SHOP.name}-এ স্বাগতম। কী খুঁজছেন জানাবেন — যেমন "লিপ লাইনার আছে?" বা "১৫০ টাকার মধ্যে ব্যাগ আছে?"`, images: [] };
  }

  // ---- delivery charge / time ----
  if (/ডেলিভারি|delivery|চার্জ|charge|পৌঁছাতে|কতদিন|সময়/.test(norm)) {
    const area = deliveryFor(text);
    const charge = area.zone === 'dhaka' ? SHOP.deliveryDhaka : area.zone === 'sub_dhaka' ? SHOP.deliverySubDhaka : SHOP.deliveryOutside;
    const areaName = area.zone === 'dhaka' ? 'ঢাকার ভেতরে' : area.zone === 'sub_dhaka' ? 'সাভার/কেরানীগঞ্জ/নারায়ণগঞ্জ/গাজীপুরে' : 'ঢাকার বাইরে';
    return {
      text: `ডেলিভারি চার্জ: ঢাকায় ${SHOP.deliveryDhaka} টাকা, সাভার/কেরানীগঞ্জ/নারায়ণগঞ্জ/গাজীপুরে ${SHOP.deliverySubDhaka} টাকা, দেশের বাকি সব জায়গায় ${SHOP.deliveryOutside} টাকা। ২,০০০ টাকার বেশি অর্ডারে ডেলিভারি ফ্রি।\n${areaName} চার্জ ${charge} টাকা।\nসময়: ${SHOP.deliveryDays}। পেমেন্ট ক্যাশ অন ডেলিভারি।`,
      images: [],
    };
  }

  // ---- payment ----
  if (/পেমেন্ট|payment|বিকাশ|নগদ|bkash|nagad|ক্যাশ/.test(norm)) {
    return { text: `পেমেন্ট ক্যাশ অন ডেলিভারি (পণ্য হাতে পেয়ে টাকা দেবেন)। ২,০০০ টাকার বেশি অর্ডারে ডেলিভারি ফ্রি।`, images: [] };
  }

  // ---- order intent ----
  const wantsOrder = /অর্ডার|order|কিনতে চাই|নিতে চাই|নেবো|নেব|কিনব/.test(norm);
  if (wantsOrder) {
    // pick a product from the last list (by number or name)
    const num = parseInt(toLatinDigits(text).replace(/[^0-9]/g, ''), 10);
    let prod = null;
    if (num >= 1 && s.lastList[num - 1]) prod = s.lastList[num - 1];
    if (!prod) {
      const hits = searchProducts(text, null);
      if (hits.length) prod = hits[0];
    }
    if (prod) {
      s.items = [{ product: prod, qty: 1 }];
      s.state = 'awaiting_qty';
      return { text: `${prod.name} — ${fmtPrice(prod)}। স্টকে আছে। কয়টা নেবেন?`, images: prod.image ? [{ url: prod.image, name: prod.name }] : [] };
    }
    s.state = 'awaiting_product';
    return { text: 'কোন প্রোডাক্টটি অর্ডার করতে চান, নামটা লিখুন (যেমন: Pearl White Earrings)।', images: [] };
  }
  if (s.state === 'awaiting_product') {
    const hits = searchProducts(text, null);
    if (hits.length) {
      s.items = [{ product: hits[0], qty: 1 }];
      s.state = 'awaiting_qty';
      return { text: `${hits[0].name} — ${fmtPrice(hits[0])}। কয়টা নেবেন?`, images: hits[0].image ? [{ url: hits[0].image, name: hits[0].name }] : [] };
    }
    return { text: 'দুঃখিত, ওই নামে কিছু পেলাম না। আরেকভাবে লিখে দেখুন, বা "কানের দুল আছে?" লিখে তালিকা দেখুন।', images: [] };
  }

  // ---- product search ----
  const budget = extractBudget(text);
  const results = searchProducts(text, budget);
  if (results.length) {
    const top = results.slice(0, 5);
    s.lastList = top;
    const lines = top.map((p, i) => `${i + 1}. ${p.name} — ${fmtPrice(p)}`).join('\n');
    const more = results.length > 5 ? `\nআরও ${results.length - 5}টি ডিজাইন আছে।` : '';
    const head = budget ? `${budget} টাকার মধ্যে` : '';
    return {
      text: `হ্যাঁ, আছে! 😊 ${head}\n${lines}${more}\nকোনটি নিতে চান জানাবেন? অর্ডার করতে নম্বর বা নাম লিখুন।`,
      images: top.slice(0, 3).filter(p => p.image).map(p => ({ url: p.image, name: p.name })),
    };
  }

  // ---- fallback: log unanswered, give phone ----
  appendJson(UNANSWERED_FILE, { time: new Date().toISOString(), psid, question: text });
  return {
    text: `দুঃখিত, এই মুহূর্তে নির্দিষ্ট তথ্য দিতে পারছি না। 😔\nআপনি ফোনে জিজ্ঞেস করতে পারেন: ${SHOP.phone}\nঅথবা আরেকভাবে লিখে দেখুন — যেমন "কানের দুল আছে?"`,
    images: [],
  };
}

// ---------------- Image matching (photo / screenshot -> product) ----------------
// Flow: download customer photo -> Gemini describes it -> catalog text search
// shortlists candidates -> Gemini compares photo vs candidate photos -> best match.
// Needs GEMINI_API_KEY (free from Google AI Studio). Without it, photo messages
// get a polite "not enabled yet" reply instead of crashing.
async function downloadImage(url) {
  const res = await fetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) throw new Error('image download HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('image too large');
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  return { buffer: buf, mime };
}

async function geminiGenerate(parts) {
  if (!GEMINI_API_KEY) return null;
  for (const model of GEMINI_MODELS) {
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) { console.error('gemini request failed', model, e.name === 'AbortError' ? 'timeout' : e.message); continue; }
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (text) return text;
      return null;
    }
    const body = await res.text().catch(() => '');
    console.error('gemini error', model, res.status, body.slice(0, 200));
    if (res.status === 503 || res.status === 429) {
      await new Promise(r => setTimeout(r, 1000)); // brief pause, then next model
      continue;
    }
    // 400/401/403/404: this model won't work, try the next one
  }
  return null;
}

async function describePhoto(img) {
  const out = await geminiGenerate([
    { inlineData: { mimeType: img.mime, data: img.buffer.toString('base64') } },
    { text: 'Look at this product photo. First write the product type using one of these exact words if it fits: lip liner, eyeliner, lipstick, lip gloss, lip balm, earrings, necklace, ring, bracelet, bangle, bag, watch, perfume, sunglass, nail polish, kajal, mascara, foundation, cream, shampoo, candle, blanket, bottle, toy, chocolate, makeup, jewellery, hair, baby, kitchen. Then add color and style in a few English words. Reply with only one line, for example: "lip liner, red and brown pencils".' },
  ]);
  return (out || '').trim();
}

// "3,1,5 high" / "0 low" / "3 high" -> {ranked:[3,1,5], confidence:'high'}
function parseMatchReply(out) {
  if (!out) return { ranked: [], confidence: 'low' };
  const m = String(out).match(/([\d,\s]+)\s*(high|medium|low)?/i);
  if (!m) return { ranked: [], confidence: 'low' };
  const ranked = m[1].split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => n >= 1);
  return { ranked, confidence: (m[2] || 'low').toLowerCase() };
}

async function matchPhoto(customerImg, candidates) {
  const parts = [
    { inlineData: { mimeType: customerImg.mime, data: customerImg.buffer.toString('base64') } },
    { text: `The first image is a customer photo. The following images are shop products, numbered 1 to ${candidates.length} in order. Which products are the same as, or the closest match to, the customer photo? Reply with ONLY this format: the numbers of the 5 closest products in order (or fewer if fewer products), then confidence for the first one: high/medium/low. Example: "3,1,5,2,4 high". If none matches well, reply "0 low".` },
  ];
  const included = [];
  for (const c of candidates) {
    try {
      const im = await downloadImage(c.image);
      parts.push({ inlineData: { mimeType: im.mime, data: im.buffer.toString('base64') } });
      included.push(c);
    } catch (e) { console.error('candidate image download failed', c.name, e.message); }
  }
  if (!included.length) return { ranked: [], confidence: 'low' };
  const out = await geminiGenerate(parts);
  const { ranked, confidence } = parseMatchReply(out);
  return { ranked: ranked.filter(n => n >= 1 && n <= included.length).map(n => included[n - 1]), confidence };
}

async function handleImageMessage(psid, imageUrl, caption) {
  const s = sessionFor(psid);
  if (!GEMINI_API_KEY) {
    return { text: 'ছবিটা পেয়েছি! 😊 ছবি দেখে মেলানোর ব্যবস্থাটা এখনো চালু হয়নি — চাবি বসালেই চালু হবে। আপাতত প্রোডাক্টের নাম লিখে জানান, যেমন "লিপ লাইনার আছে?"', images: [] };
  }
  let photo;
  try { photo = await downloadImage(imageUrl); }
  catch (e) { console.error('customer image download failed', e.message); return { text: 'ছবিটা ডাউনলোড করা যায়নি, আবার পাঠাবেন কি?', images: [] }; }
  const description = await describePhoto(photo);
  console.log('photo described as:', description);
  const queryText = ((caption || '') + ' ' + (description || '')).trim();
  if (!queryText) {
    return { text: 'ছবিটা দেখলাম, কিন্তু কী জিনিস বুঝতে পারলাম না। 😔 এটা কী প্রোডাক্ট, নামটা লিখে জানাবেন কি?', images: [] };
  }
  const candidates = searchProducts(queryText, null).slice(0, 5);
  if (!candidates.length) {
    return { text: `ছবিটা দেখলাম, কিন্তু আমাদের ক্যাটালগে এর সাথে মিলে এমন কিছু পেলাম না। 😔 ফোনে জানালে সাহায্য করতে পারবো: ${SHOP.phone}`, images: [] };
  }
  const { ranked, confidence } = await matchPhoto(photo, candidates);
  const picked = ranked[0] || null;
  if (picked && confidence === 'high') {
    s.lastList = [picked, ...candidates.filter(c => c !== picked)];
    return { text: `এটা কি এই প্রোডাক্টটা? 😊\n${picked.name} — ${fmtPrice(picked)}। স্টকে আছে।\nমিলে গেলে অর্ডার করতে "অর্ডার করতে চাই" লিখুন।`, images: picked.image ? [{ url: picked.image, name: picked.name }] : [] };
  }
  const top = (ranked.length ? ranked : candidates).slice(0, 5);
  s.lastList = top;
  const lines = top.map((p, i) => `${i + 1}. ${p.name} — ${fmtPrice(p)}`).join('\n');
  return { text: `হুবহু মিল পেলাম না, তবে সবচেয়ে কাছাকাছি এগুলো আছে:\n${lines}\nএর মধ্যে কোনটা? নম্বর লিখুন।`, images: top.slice(0, 3).filter(p => p.image).map(p => ({ url: p.image, name: p.name })) };
}

// ---------------- Sending via Graph API ----------------
async function sendToFacebook(psid, reply) {
  if (DRY_RUN || !PAGE_ACCESS_TOKEN) {
    console.log('[DRY_RUN] ->', psid, JSON.stringify(reply, null, 1).slice(0, 2000));
    return { dryRun: true };
  }
  const out = [];
  const textRes = await fetch(`${GRAPH_API}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text: reply.text } }),
  });
  const textBody = await textRes.json().catch(() => ({}));
  if (!textRes.ok) console.error('graph send failed', textRes.status, JSON.stringify(textBody).slice(0, 500));
  else console.log('graph send ok to', psid, JSON.stringify(textBody).slice(0, 200));
  out.push(textBody);
  for (const img of (reply.images || []).slice(0, 3)) {
    const r = await fetch(`${GRAPH_API}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { attachment: { type: 'image', payload: { url: img.url, is_reusable: true } } } }),
    });
    const imgBody = await r.json().catch(() => ({}));
    if (!r.ok) console.error('graph image send failed', r.status, JSON.stringify(imgBody).slice(0, 500));
    out.push(imgBody);
  }
  return out;
}

// ---------------- Express app ----------------
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

function verifySignature(req) {
  if (!APP_SECRET) return true;
  const sig = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

app.get('/', (_req, res) => res.send(`99 Shop Messenger bot — alive. Products in catalog: ${CATALOG.length}.`));
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, products: CATALOG.length, loadedAt: catalogLoadedAt }));

// Diagnostics (admin only): checks the Page token against the Graph API and
// reports whether the bot can actually send. Never returns the token itself.
app.get('/diag', async (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.sendStatus(403);
  let graph = { ok: false };
  if (!PAGE_ACCESS_TOKEN) graph = { ok: false, error: 'no PAGE_ACCESS_TOKEN set' };
  else {
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`);
      const j = await r.json().catch(() => ({}));
      graph = r.ok
        ? { ok: true, id: j.id, name: j.name }
        : { ok: false, status: r.status, error: j.error && j.error.message, code: j.error && j.error.code };
    } catch (e) { graph = { ok: false, error: e.message }; }
  }
  res.json({ ok: true, version: VERSION, products: CATALOG.length, dryRun: DRY_RUN, hasPageToken: !!PAGE_ACCESS_TOKEN, pageTokenLength: PAGE_ACCESS_TOKEN.length, hasAppSecret: !!APP_SECRET, graph });
});

// Bot on/off switch (admin only)
app.get('/bot-state', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.sendStatus(403);
  res.json({ ok: true, enabled: BOT_ENABLED });
});
app.post('/bot-toggle', express.urlencoded({ extended: false }), (req, res) => {
  if (req.query.token !== ADMIN_TOKEN && req.body.token !== ADMIN_TOKEN) return res.sendStatus(403);
  BOT_ENABLED = req.body.enabled === '1' || req.body.enabled === 'true';
  saveBotState();
  console.log('bot', BOT_ENABLED ? 'enabled' : 'disabled');
  const token = req.query.token || req.body.token;
  res.redirect(`/orders?token=${encodeURIComponent(token)}`);
});

// Privacy policy (used as Meta's Privacy Policy URL) — Bengali + English
app.get('/privacy', (_req, res) => {
  res.send(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><title>গোপনীয়তা নীতি — 99 Shop</title></head><body>
<h1>গোপনীয়তা নীতি (Privacy Policy) — 99 Shop Bangladesh</h1>
<p>99 Shop Bangladesh-এর ফেসবুক মেসেঞ্জার বট ("99 Shop Bot") ব্যবহারকারীদের মেসেজের উত্তর দেয় এবং অর্ডার নেয়। এই নীতি ব্যাখ্যা করে বটটি কী তথ্য সংগ্রহ করে ও কীভাবে ব্যবহার করে।</p>
<h2>কী তথ্য সংগ্রহ করা হয়</h2>
<ul><li>আপনার মেসেঞ্জার বার্তা (টেক্সট ও ছবি) এবং ফেসবুক প্রেরক আইডি — শুধু উত্তর দিতে ও অর্ডার নিতে।</li>
<li>অর্ডারের তথ্য (নাম, মোবাইল নম্বর, ঠিকানা, পণ্য) — শুধু ডেলিভারির জন্য।</li></ul>
<h2>তথ্য কীভাবে ব্যবহার করা হয়</h2>
<ul><li>বার্তার উত্তর ও অর্ডার প্রক্রিয়াকরণ ছাড়া অন্য কোনো কাজে তথ্য ব্যবহার করা হয় না।</li>
<li>ছবি পাঠালে ছবিটি শুধু পণ্য মেলাতে Google Gemini-তে পাঠানো হয়, অন্য কোথাও সংরক্ষণ করা হয় না।</li>
<li>তথ্য তৃতীয় পক্ষের কাছে বিক্রি বা ভাড়া দেওয়া হয় না। Facebook (Messenger প্ল্যাটফর্ম) ও দোকানের ক্যাটালগ সার্ভার ছাড়া কারো সাথে শেয়ার করা হয় না।</li></ul>
<h2>তথ্য মুছতে চাইলে</h2>
<p>আপনার তথ্য মুছে ফেলতে <a href="/delete-data">তথ্য মোছার পাতা</a> দেখুন, অথবা info@99shop.com-এ ইমেইল করুন বা 01918107441 নম্বরে কল করুন।</p>
<h2>যোগাযোগ</h2>
<p>99 Shop Bangladesh, Shop No# 117, 3rd Floor, Newmarket City Complex, Dhaka-1205। ফোন/WhatsApp: 01918107441, ইমেইল: info@99shop.com।</p>
<p><i>What data the bot collects: your Messenger messages (text and photos) and sender ID, only to reply and take orders; order details (name, phone, address, items) only for delivery. Photos are sent to Google Gemini only to match products. Data is never sold, and is shared only with Meta's Messenger platform and the shop's own catalog server. To delete your data, see the deletion page or email info@99shop.com.</i></p>
</body></html>`);
});

// User data deletion instructions (Meta's User Data Deletion URL)
app.get('/delete-data', (_req, res) => {
  res.send(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><title>তথ্য মোছা — 99 Shop</title></head><body>
<h1>তথ্য মোছার অনুরোধ (Data Deletion)</h1>
<p>99 Shop Bot আপনার যে তথ্য রেখেছে (মেসেজ, অর্ডারের তথ্য) তা মুছে ফেলতে চাইলে info@99shop.com-এ ইমেইল করুন অথবা 01918107441 নম্বরে কল/WhatsApp করুন। আপনার ফেসবুক নাম ও মোবাইল নম্বর জানাবেন, যাতে আপনার অর্ডারটি খুঁজে পাওয়া যায়। অনুরোধ পাওয়ার ৭ দিনের মধ্যে আপনার তথ্য মুছে ফেলা হবে এবং ইমেইলে/মেসেজে জানানো হবে।</p>
<p><i>To request deletion of your data, email info@99shop.com or call/WhatsApp 01918107441 with your Facebook name and phone number. Your data will be deleted within 7 days.</i></p>
</body></html>`);
});

// Facebook webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Facebook webhook events
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);
  res.status(200).send('EVENT_RECEIVED');
  if (!BOT_ENABLED) { console.log('bot disabled — ignoring incoming message'); return; }
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const sender = ev.sender && ev.sender.id;
      if (!sender || !ev.message || ev.message.is_echo) continue;
      console.log('webhook event from', sender, 'text:', (ev.message.text || '').slice(0, 100), 'attachments:', (ev.message.attachments || []).length);
      try {
        const atts = (ev.message.attachments || []).filter(a => a.type === 'image' && a.payload && a.payload.url);
        let reply;
        if (atts.length) reply = await handleImageMessage(sender, atts[0].payload.url, ev.message.text || '');
        else if (ev.message.text) reply = brain(sender, ev.message.text);
        else continue;
        await sendToFacebook(sender, reply);
      } catch (e) { console.error('reply failed for', sender, e.message); }
    }
  }
});

// Test endpoint: try the brain without Facebook (POST {"text":"লিপ লাইনার আছে?"})
app.post('/test', (req, res) => {
  const text = (req.body && req.body.text) || '';
  const reply = brain('test-user', text);
  res.json({ reply });
});

// Test endpoint: try photo matching without Facebook (POST {"imageUrl":"https://...","text":"..."})
app.post('/test-image', async (req, res) => {
  const url = req.body && req.body.imageUrl;
  const text = (req.body && req.body.text) || '';
  if (!url) return res.status(400).json({ error: 'imageUrl needed' });
  const reply = await handleImageMessage('test-user', url, text);
  res.json({ reply });
});

// Manual catalog refresh
app.get('/refresh', async (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.sendStatus(403);
  await loadCatalog();
  res.json({ ok: true, products: CATALOG.length });
});

// Simple orders admin page (also hosts the bot on/off switch)
app.get('/orders', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.sendStatus(403);
  const orders = readJson(ORDERS_FILE, []).slice().reverse();
  const rows = orders.map(o => `<tr><td>${o.id}</td><td>${o.time}</td><td>${o.items.map(i => `${i.name} × ${i.qty}`).join('<br>')}</td><td>${o.total} টাকা</td><td>${o.name}<br>${o.phone}<br>${o.address}</td><td>${o.status}</td></tr>`).join('');
  const token = encodeURIComponent(req.query.token);
  const switchBox = BOT_ENABLED
    ? `<p>বটের অবস্থা: <b>চালু ✅</b></p><form method="POST" action="/bot-toggle?token=${token}"><input type="hidden" name="enabled" value="0"><button type="submit">বট বন্ধ করুন</button></form><p>বন্ধ থাকলে বট একদম চুপ থাকবে — কোনো মেসেজের উত্তর দেবে না।</p>`
    : `<p>বটের অবস্থা: <b>বন্ধ ⏸️</b></p><form method="POST" action="/bot-toggle?token=${token}"><input type="hidden" name="enabled" value="1"><button type="submit">বট চালু করুন</button></form><p>বন্ধ থাকলে বট একদম চুপ থাকে — কোনো মেসেজের উত্তর দেয় না।</p>`;
  res.send(`<!doctype html><html lang="bn"><head><meta charset="utf-8"><title>অর্ডার তালিকা — 99 Shop</title></head><body><h1>অর্ডার তালিকা (${orders.length})</h1>${switchBox}<table border="1" cellpadding="6"><tr><th>নম্বর</th><th>সময়</th><th>পণ্য</th><th>মোট</th><th>কাস্টমার</th><th>অবস্থা</th></tr>${rows}</table></body></html>`);
});

if (require.main === module) {
  loadCatalogCache(); // instant catalog from snapshot; refreshed below
  loadCatalog().catch(e => console.error('initial catalog load failed', e.message));
  app.listen(PORT, () => console.log(`99 Shop bot listening on :${PORT} (dryRun=${DRY_RUN})`));
}
module.exports = { app, brain, searchProducts, parseMatchReply, handleImageMessage, loadCatalog };
