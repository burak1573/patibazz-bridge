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
