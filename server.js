import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ====== ENV (Render > Environment) ======
const IDEASOFT_BASE = process.env.IDEASOFT_BASE; // örn: https://burakkayar.myideasoft.com
const CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;

// İlk token aldıktan sonra buraya koyacağız (Step 7'de)
// Render env'e yazacağız, kod buradan okuyacak:
let accessToken = process.env.IDEASOFT_ACCESS_TOKEN || "";
let refreshToken = process.env.IDEASOFT_REFRESH_TOKEN || "";
let tokenExpiresAt = Number(process.env.IDEASOFT_TOKEN_EXPIRES_AT || "0"); // epoch ms

function nowMs() { return Date.now(); }

async function ideasoftTokenByRefresh() {
  if (!refreshToken) throw new Error("refresh_token yok. Önce initial token alınmalı.");

  const url = `${IDEASOFT_BASE}/oauth/v2/token`;
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`refresh token error: ${res.status} ${JSON.stringify(json)}`);
  }

  accessToken = json.access_token;
  if (json.refresh_token) refreshToken = json.refresh_token;

  // expires_in saniye ise:
  const expiresInSec = Number(json.expires_in || 0);
  tokenExpiresAt = expiresInSec ? (nowMs() + (expiresInSec * 1000)) : (nowMs() + 30 * 60 * 1000);

  return { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresInSec };
}

async function ensureAccessToken() {
  // 60 sn buffer
  if (accessToken && tokenExpiresAt && (nowMs() < tokenExpiresAt - 60_000)) return;
  await ideasoftTokenByRefresh();
}

async function ideasoftGet(path) {
  await ensureAccessToken();

  const url = `${IDEASOFT_BASE}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json"
    }
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    // token bozulduysa bir kere refresh deneyelim
    if (res.status === 401 || res.status === 403) {
      await ideasoftTokenByRefresh();
      const res2 = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/json"
        }
      });
      const text2 = await res2.text();
      let json2;
      try { json2 = JSON.parse(text2); } catch { json2 = { raw: text2 }; }
      if (!res2.ok) throw new Error(`GET ${path} error: ${res2.status} ${JSON.stringify(json2)}`);
      return json2;
    }
    throw new Error(`GET ${path} error: ${res.status} ${JSON.stringify(json)}`);
  }

  return json;
}

// ====== Basit sınıflandırma (v0) ======
function classifyProduct(p) {
  const hay = `${p?.name || ""} ${p?.description || ""} ${p?.shortDescription || ""}`.toLowerCase();

  const tags = new Set();

  // kedi/köpek
  if (/(kedi|cat)/.test(hay)) tags.add("cat");
  if (/(köpek|kopek|dog)/.test(hay)) tags.add("dog");

  // tedavi niyeti (basit keyword)
  if (/(renal|böbrek|bobrek|kidney)/.test(hay)) tags.add("renal");
  if (/(urinary|üriner|uriner|idrar|struvit|oxalat|cystitis|sistit)/.test(hay)) tags.add("urinary");
  if (/(gastro|gastrointestinal|gi|sindirim|ishal|kusma)/.test(hay)) tags.add("gi");
  if (/(hypoallergenic|hipoalerjenik|allergy|alerji|dermatit)/.test(hay)) tags.add("hypoallergenic");
  if (/(recovery|convalescence|iyileşme|iyilesme|kritik|critical care)/.test(hay)) tags.add("recovery");
  if (/(diabetes|diyabet|glucose|şeker|seker)/.test(hay)) tags.add("diabetes");
  if (/(obesity|kilo|weight|zayıf|zayif|satiety)/.test(hay)) tags.add("weight");

  return Array.from(tags);
}

// ====== Routes ======
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "patibazz-bridge",
    has_access_token: Boolean(accessToken),
    has_refresh_token: Boolean(refreshToken),
    token_expires_at: tokenExpiresAt || null
  });
});

// Ürünleri aynen döner (IdeaSoft)
app.get("/products", async (req, res) => {
  try {
    // IdeaSoft response şekline göre gerekirse ayarlayacağız
    const data = await ideasoftGet("/api/products");
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Ürünleri sınıflandırılmış döner (v0)
app.get("/products-classified", async (_req, res) => {
  try {
    const data = await ideasoftGet("/api/products");

    // data bir liste mi, yoksa {data: []} mi? İkisini de idare edelim
    const list = Array.isArray(data) ? data : (data?.data || data?.items || []);
    const out = list.map(p => ({
      id: p?.id ?? p?.productId ?? null,
      name: p?.name ?? p?.title ?? "",
      slug: p?.slug ?? p?.seoUrl ?? "",
      price: p?.price ?? p?.salePrice ?? null,
      tags: classifyProduct(p),
      raw: p
    }));

    res.json({ count: out.length, items: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ====== Start ======
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`patibazz-bridge listening on :${port}`));
// ====== AI Answer (TR+EN) - v1 (rule-based) ======
function detectLang(q) {
  const trChars = /[çğıİıöşüÇĞÖŞÜ]/;
  const trWords = /\b(kedi|köpek|mama|böbrek|idrar|sindirim|alerji|diyabet|zayıflama|veteriner)\b/i;
  if (trChars.test(q) || trWords.test(q)) return "tr";
  return "en";
}

function inferIntent(q) {
  const t = q.toLowerCase();
  const intent = new Set();

  // species
  if (/(kedi|cat)/.test(t)) intent.add("cat");
  if (/(köpek|kopek|dog)/.test(t)) intent.add("dog");

  // conditions
  if (/(renal|böbrek|bobrek|kidney)/.test(t)) intent.add("renal");
  if (/(urinary|üriner|uriner|idrar|struvit|oxalat|cystitis|sistit)/.test(t)) intent.add("urinary");
  if (/(gastro|gastrointestinal|gi|sindirim|ishal|kusma|vomit|diarrhea)/.test(t)) intent.add("gi");
  if (/(hypoallergenic|hipoalerjenik|allergy|alerji|dermatit|itch|kaşıntı|kasinti)/.test(t)) intent.add("hypoallergenic");
  if (/(recovery|convalescence|iyileşme|iyilesme|kritik|critical care)/.test(t)) intent.add("recovery");
  if (/(diabetes|diyabet|glucose|şeker|seker)/.test(t)) intent.add("diabetes");
  if (/(obesity|kilo|weight|zayıf|zayif|satiety|light)/.test(t)) intent.add("weight");

  return Array.from(intent);
}

function pickProducts(items, intent) {
  // intent tagleriyle en çok eşleşen ilk 5 ürünü seç
  const intentSet = new Set(intent);
  const scored = items.map(p => {
    const tags = new Set(p.tags || []);
    let score = 0;
    for (const it of intentSet) if (tags.has(it)) score += 3;
    // tür bilinmiyorsa cat/dog eşleşmesine puan verme
    if (!intentSet.has("cat") && !intentSet.has("dog")) {
      // no-op
    }
    return { ...p, _score: score };
  });

  return scored
    .filter(x => x._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 5)
    .map(({ _score, ...rest }) => rest);
}

function buildAnswer(lang, intent) {
  const has = (t) => intent.includes(t);

  if (lang === "tr") {
    let lines = [];
    lines.push("Genel bilgilendirme: Uygun mama seçimi, tanı ve hastalık evresine göre değişir. Mümkünse veterinerinizin önerisini baz alın.");
    if (has("renal")) lines.push("Böbrek (renal) destek mamalar genelde düşük fosfor, kontrollü protein ve destekleyici omega-3 profiline sahiptir.");
    if (has("urinary")) lines.push("Üriner destek mamalar idrar pH’ını ve mineral dengesini yöneterek struvit/taş riskini azaltmaya yardımcı olur.");
    if (has("gi")) lines.push("Gastrointestinal (GI) mamalar sindirimi kolay içerik ve dengeli lif profiliyle kusma/ishal dönemlerinde destek sağlar.");
    if (has("hypoallergenic")) lines.push("Hipoalerjenik mamalar genellikle tek protein/hidrolize protein yaklaşımıyla gıda hassasiyetlerinde kullanılır.");
    if (has("diabetes")) lines.push("Diyabet destek mamalar genellikle kontrollü karbonhidrat ve uygun lif dengesiyle glisemik yönetimi destekler.");
    if (has("weight")) lines.push("Kilo yönetimi mamaları kalori kontrolü ve tokluk (satiety) yaklaşımıyla kilo verme sürecini destekler.");

    lines.push("Aşağıda sorunuza en yakın ürünleri listeledim. Ürün detaylarını patibazz.com.tr üzerinden inceleyip hızlıca temin edebilirsiniz.");
    return lines.join(" ");
  }

  // EN
  let lines = [];
  lines.push("General info: The best diet depends on diagnosis and disease stage. If possible, follow your vet’s guidance.");
  if (has("renal")) lines.push("Renal diets often feature lower phosphorus, controlled protein, and supportive omega-3 profiles.");
  if (has("urinary")) lines.push("Urinary diets help manage urine pH and mineral balance to reduce struvite/stone risk.");
  if (has("gi")) lines.push("Gastrointestinal (GI) diets use highly digestible ingredients and balanced fiber to support vomiting/diarrhea periods.");
  if (has("hypoallergenic")) lines.push("Hypoallergenic diets typically use single or hydrolyzed proteins for food sensitivities.");
  if (has("diabetes")) lines.push("Diabetes-support diets often use controlled carbs and suitable fiber to support glycemic management.");
  if (has("weight")) lines.push("Weight-management diets support weight loss with calorie control and satiety-focused formulations.");

  lines.push("Below are the closest matching products. You can review details and purchase via patibazz.com.tr.");
  return lines.join(" ");
}

app.get("/ai-answer", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "q param required" });

    const lang = detectLang(q);
    const intent = inferIntent(q);

    // ürünleri classified olarak alalım (kendi fonksiyonumuzla)
    const data = await ideasoftGet("/api/products");
    const list = Array.isArray(data) ? data : (data?.data || data?.items || []);

    const items = list.map(p => ({
      id: p?.id ?? p?.productId ?? null,
      name: p?.name ?? p?.title ?? "",
      slug: p?.slug ?? p?.seoUrl ?? "",
      price: p?.price ?? p?.salePrice ?? null,
      tags: classifyProduct(p)
    }));

    const picks = pickProducts(items, intent).map(p => ({
      name: p.name,
      price: p.price,
      tags: p.tags,
      // IdeaSoft slug senin sitedeki URL ile birebir olmayabilir.
      // Şimdilik patibazz.com.tr üzerinde slug ile link kuruyoruz:
      url: p.slug ? `https://patibazz.com.tr/${p.slug}` : "https://patibazz.com.tr"
    }));

    const answer = buildAnswer(lang, intent);

    res.json({
      ok: true,
      lang,
      intent,
      q,
      answer,
      products: picks
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

