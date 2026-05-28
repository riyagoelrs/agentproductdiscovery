'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3003;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
// Serve the frontend from the repo root
app.use(express.static(path.join(__dirname, '..')));

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS brands (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    data TEXT NOT NULL,
    checklist TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS measurements (
    id TEXT PRIMARY KEY,
    brand_id TEXT NOT NULL REFERENCES brands(id),
    score INTEGER NOT NULL,
    breakdown TEXT NOT NULL,
    platform_scores TEXT NOT NULL,
    keyword_scores TEXT NOT NULL,
    baseline INTEGER NOT NULL DEFAULT 8,
    after_score INTEGER NOT NULL DEFAULT 8,
    measurement_type TEXT DEFAULT 'simulation',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );
`);

// ─── Email ────────────────────────────────────────────────────────────────────

let _transporter = null;

async function getTransporter() {
  if (_transporter) return _transporter;
  if (process.env.SMTP_HOST) {
    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  } else {
    // Dev: use Ethereal (fake SMTP, messages viewable at ethereal.email)
    const testAccount = await nodemailer.createTestAccount();
    _transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
    console.log('\n📧 Dev email mode — view sent emails at https://ethereal.email');
    console.log(`   User: ${testAccount.user} | Pass: ${testAccount.pass}\n`);
  }
  return _transporter;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No session token' });
  const session = db
    .prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .get(token, Math.floor(Date.now() / 1000));
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  req.userId = session.user_id;
  next();
}

// ─── Measurement engine ───────────────────────────────────────────────────────

/**
 * Score a brand profile on a 0-100 scale.
 *
 * Breakdown:
 *   - Profile completeness   30 pts  (15 key fields × 2)
 *   - Intent quality         20 pts  (number + specificity of shopping intents)
 *   - Proof & trust          20 pts  (proof points + certifications)
 *   - Structured data        15 pts  (JSON-LD completeness proxy)
 *   - Checklist actions      15 pts  (platform action items completed)
 */
function scoreBrand(data, checklist = {}) {
  // 1. Profile completeness (30 pts)
  const profileFields = [
    'brand', 'product', 'category', 'price', 'url', 'productUrl',
    'audience', 'intents', 'differentiators', 'proof', 'inventory',
    'returns', 'shipping', 'rating', 'certifications'
  ];
  const filledCount = profileFields.filter(f => {
    const v = data[f];
    return v && String(v).trim().length > 0;
  }).length;
  const completeness = Math.round((filledCount / profileFields.length) * 30);

  // 2. Intent quality (20 pts)
  const intents = splitLines(data.intents);
  const intentCount = Math.min(intents.length, 5);
  // Bonus if intents are specific (contain "for" or "with" or multi-word)
  const specificIntents = intents.filter(i => i.split(' ').length >= 3 || /\bfor\b|\bwith\b/.test(i)).length;
  const intentScore = Math.min(intentCount * 3 + Math.min(specificIntents * 1, 5), 20);

  // 3. Proof & trust (20 pts)
  const proofs = splitLines(data.proof);
  const proofCount = Math.min(proofs.length, 5);
  const proofScore = proofCount * 3;
  const certText = String(data.certifications || '').trim();
  const certBonus = certText.length > 0 ? Math.min(certText.split(/[,\n]/).filter(Boolean).length * 2, 5) : 0;
  const trustScore = Math.min(proofScore + certBonus, 20);

  // 4. Structured data quality (15 pts) — proxy: how many JSON-LD-relevant fields filled
  const jsonLdFields = ['brand', 'product', 'price', 'inventory', 'returns', 'url', 'rating', 'category'];
  const jsonLdFilled = jsonLdFields.filter(f => data[f] && String(data[f]).trim()).length;
  const structuredDataScore = Math.round((jsonLdFilled / jsonLdFields.length) * 15);

  // 5. Checklist actions (15 pts)
  const totalChecklistItems = 28; // sum of all platform items
  const checkedCount = Object.values(checklist).filter(Boolean).length;
  const checklistScore = Math.round((checkedCount / totalChecklistItems) * 15);

  const total = completeness + intentScore + trustScore + structuredDataScore + checklistScore;

  // Visibility mapping: score 0-100 → mention likelihood 5-72%
  const baseline = 8;
  const afterMention = Math.round(5 + (total / 100) * 67);

  // Per-platform scores (each platform weighs factors differently)
  const platformScores = {
    google:     clamp(Math.round(completeness * 0.9 + structuredDataScore * 1.2 + checklistScore * 0.9), 0, 100),
    openai:     clamp(Math.round(intentScore * 1.4 + trustScore * 0.8 + structuredDataScore), 0, 100),
    anthropic:  clamp(Math.round(trustScore * 1.3 + intentScore * 1.1 + structuredDataScore * 0.9), 0, 100),
    perplexity: clamp(Math.round(proofScore * 1.5 + intentScore + structuredDataScore * 0.8), 0, 100),
    shopify:    clamp(Math.round(completeness * 0.8 + checklistScore * 1.4 + trustScore * 0.6), 0, 100)
  };

  // Per-keyword scores
  const keywordScores = intents.slice(0, 6).map(intent => {
    // More specific intents get higher scores
    const specificity = intent.split(' ').length >= 4 ? 1.15 : 1.0;
    return {
      query: intent,
      baseline: Math.floor(Math.random() * 6) + 2,
      after: clamp(Math.round(afterMention * specificity * (0.85 + Math.random() * 0.3)), 0, 95)
    };
  });

  // Improvement suggestions
  const suggestions = [];
  if (completeness < 20) suggestions.push({ field: 'profile', text: 'Fill in your website URL, product URL, and shipping speed to boost structured data coverage.' });
  if (intentScore < 12) suggestions.push({ field: 'intents', text: 'Add at least 4–5 specific shopping intents (e.g. "reef-safe sunscreen for sensitive skin").' });
  if (trustScore < 12) suggestions.push({ field: 'proof', text: 'Add third-party certifications and at least 3 specific proof points backed by evidence.' });
  if (structuredDataScore < 10) suggestions.push({ field: 'structured', text: 'Add your product URL and average rating so JSON-LD output covers all required fields.' });
  if (checklistScore < 5) suggestions.push({ field: 'checklist', text: 'Complete platform action items — especially Google Merchant Center and Bing/OpenAI submission.' });

  return {
    score: total,
    breakdown: { completeness, intentScore, trustScore, structuredDataScore, checklistScore },
    baseline,
    afterMention,
    platformScores,
    keywordScores,
    suggestions
  };
}

function splitLines(str) {
  return String(str || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ─── Real AI query stubs (wire in with API keys) ──────────────────────────────

/**
 * Query Perplexity's API with a shopping prompt.
 * Returns { mentioned: boolean, excerpt: string|null } or null if not configured.
 */
async function queryPerplexity(prompt, brandName) {
  if (!process.env.PERPLEXITY_API_KEY) return null;
  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512
      })
    });
    const json = await resp.json();
    const text = json.choices?.[0]?.message?.content || '';
    const mentioned = text.toLowerCase().includes(brandName.toLowerCase());
    const excerpt = mentioned
      ? text.slice(Math.max(0, text.toLowerCase().indexOf(brandName.toLowerCase()) - 80), text.toLowerCase().indexOf(brandName.toLowerCase()) + 80)
      : null;
    return { mentioned, excerpt };
  } catch (e) {
    console.error('Perplexity query failed:', e.message);
    return null;
  }
}

/**
 * Query OpenAI with web search enabled.
 * Returns { mentioned: boolean, excerpt: string|null } or null if not configured.
 */
async function queryOpenAI(prompt, brandName) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview' }],
        input: prompt
      })
    });
    const json = await resp.json();
    const text = json.output?.find(o => o.type === 'message')?.content?.[0]?.text || '';
    const mentioned = text.toLowerCase().includes(brandName.toLowerCase());
    const excerpt = mentioned
      ? text.slice(Math.max(0, text.toLowerCase().indexOf(brandName.toLowerCase()) - 80), text.toLowerCase().indexOf(brandName.toLowerCase()) + 80)
      : null;
    return { mentioned, excerpt };
  } catch (e) {
    console.error('OpenAI query failed:', e.message);
    return null;
  }
}

/**
 * Query Google Gemini with search grounding.
 * Returns { mentioned: boolean, excerpt: string|null } or null if not configured.
 */
async function queryGemini(prompt, brandName) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        })
      }
    );
    const json = await resp.json();
    const text = json.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    const mentioned = text.toLowerCase().includes(brandName.toLowerCase());
    const excerpt = mentioned
      ? text.slice(Math.max(0, text.toLowerCase().indexOf(brandName.toLowerCase()) - 80), text.toLowerCase().indexOf(brandName.toLowerCase()) + 80)
      : null;
    return { mentioned, excerpt };
  } catch (e) {
    console.error('Gemini query failed:', e.message);
    return null;
  }
}

/**
 * Run real AI queries for a brand across its shopping intents.
 * Falls back to simulation for platforms where no API key is set.
 */
async function runRealMeasurement(brand) {
  const data = JSON.parse(brand.data);
  const intents = splitLines(data.intents).slice(0, 5);
  const brandName = data.brand || '';
  const results = {};

  for (const intent of intents) {
    const prompt = `What are the best products for: ${intent}? Recommend specific brands.`;
    const [perplexity, openai, gemini] = await Promise.all([
      queryPerplexity(prompt, brandName),
      queryOpenAI(prompt, brandName),
      queryGemini(prompt, brandName)
    ]);
    results[intent] = { perplexity, openai, gemini };
  }
  return results;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/auth/request — send magic link
app.post('/api/auth/request', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    user = { id: crypto.randomUUID(), email: email.toLowerCase() };
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(user.id, user.email);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expiresAt);

  const magicLink = `${FRONTEND_URL}/api/auth/verify?token=${token}`;
  const isNew = db.prepare('SELECT COUNT(*) as c FROM brands WHERE user_id = ?').get(user.id).c === 0;

  try {
    const t = await getTransporter();
    const info = await t.sendMail({
      from: process.env.FROM_EMAIL || '"Agentic Shelf" <noreply@agenticshelf.com>',
      to: email,
      subject: isNew ? 'Welcome to Agentic Shelf — sign in link' : 'Your Agentic Shelf sign-in link',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 8px;color:#17202a">Agentic Shelf</h2>
          <p style="color:#667381;margin:0 0 24px;font-size:15px">AI visibility for emerging brands</p>
          <a href="${magicLink}"
             style="display:inline-block;background:#2868d8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
            ${isNew ? 'Create my account' : 'Sign in'}
          </a>
          <p style="color:#667381;font-size:13px;margin-top:24px">
            This link expires in 1 hour. If you didn't request this, you can ignore it.
          </p>
        </div>
      `
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log('📧 Magic link preview:', previewUrl);

    res.json({
      ok: true,
      isNew,
      // In dev, return the preview URL so it can be surfaced in the UI
      ...(previewUrl ? { devPreviewUrl: previewUrl, magicLink } : {})
    });
  } catch (err) {
    console.error('Email send error:', err);
    res.status(500).json({ error: 'Could not send email. Check SMTP configuration.' });
  }
});

// GET /api/auth/verify?token=... — consume magic link, redirect with session
app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const authToken = db
    .prepare('SELECT * FROM auth_tokens WHERE token = ? AND expires_at > ? AND used = 0')
    .get(token, Math.floor(Date.now() / 1000));

  if (!authToken) {
    return res.redirect('/?auth=failed');
  }

  db.prepare('UPDATE auth_tokens SET used = 1 WHERE token = ?').run(token);

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30 days
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(sessionToken, authToken.user_id, expiresAt);

  res.redirect(`/?session=${sessionToken}`);
});

// GET /api/auth/me — current user + their brand
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.userId);
  const brand = db.prepare('SELECT * FROM brands WHERE user_id = ?').get(req.userId);
  res.json({
    user,
    brand: brand
      ? { id: brand.id, data: JSON.parse(brand.data), checklist: JSON.parse(brand.checklist), updatedAt: brand.updated_at }
      : null
  });
});

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.slice(7);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// POST /api/brands — upsert brand profile + auto-measure
app.post('/api/brands', requireAuth, (req, res) => {
  const { data, checklist } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data is required' });

  const now = Math.floor(Date.now() / 1000);
  let brand = db.prepare('SELECT * FROM brands WHERE user_id = ?').get(req.userId);

  if (brand) {
    db.prepare('UPDATE brands SET data = ?, checklist = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(data), JSON.stringify(checklist || {}), now, brand.id);
  } else {
    brand = { id: crypto.randomUUID() };
    db.prepare('INSERT INTO brands (id, user_id, data, checklist, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(brand.id, req.userId, JSON.stringify(data), JSON.stringify(checklist || {}), now, now);
  }

  const measurement = scoreBrand(data, checklist || {});
  const mid = crypto.randomUUID();
  db.prepare(`
    INSERT INTO measurements (id, brand_id, score, breakdown, platform_scores, keyword_scores, baseline, after_score, measurement_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simulation')
  `).run(mid, brand.id, measurement.score, JSON.stringify(measurement.breakdown),
    JSON.stringify(measurement.platformScores), JSON.stringify(measurement.keywordScores),
    measurement.baseline, measurement.afterMention);

  res.json({ ok: true, brandId: brand.id, measurement });
});

// PATCH /api/brands/me/checklist — update checklist without re-running full form
app.patch('/api/brands/me/checklist', requireAuth, (req, res) => {
  const { checklist } = req.body || {};
  const now = Math.floor(Date.now() / 1000);
  const brand = db.prepare('SELECT * FROM brands WHERE user_id = ?').get(req.userId);
  if (!brand) return res.status(404).json({ error: 'No brand profile yet' });

  db.prepare('UPDATE brands SET checklist = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(checklist || {}), now, brand.id);

  const data = JSON.parse(brand.data);
  const measurement = scoreBrand(data, checklist || {});
  const mid = crypto.randomUUID();
  db.prepare(`
    INSERT INTO measurements (id, brand_id, score, breakdown, platform_scores, keyword_scores, baseline, after_score, measurement_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simulation')
  `).run(mid, brand.id, measurement.score, JSON.stringify(measurement.breakdown),
    JSON.stringify(measurement.platformScores), JSON.stringify(measurement.keywordScores),
    measurement.baseline, measurement.afterMention);

  res.json({ ok: true, measurement });
});

// GET /api/brands/me/measurements — full measurement history
app.get('/api/brands/me/measurements', requireAuth, (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE user_id = ?').get(req.userId);
  if (!brand) return res.json({ measurements: [] });

  const rows = db.prepare('SELECT * FROM measurements WHERE brand_id = ? ORDER BY created_at ASC').all(brand.id);
  res.json({
    measurements: rows.map(m => ({
      id: m.id,
      score: m.score,
      baseline: m.baseline,
      afterMention: m.after_score,
      breakdown: JSON.parse(m.breakdown),
      platformScores: JSON.parse(m.platform_scores),
      keywordScores: JSON.parse(m.keyword_scores),
      measurementType: m.measurement_type,
      createdAt: m.created_at
    }))
  });
});

// POST /api/brands/me/measure — manual re-measure (includes real AI queries if keys set)
app.post('/api/brands/me/measure', requireAuth, async (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE user_id = ?').get(req.userId);
  if (!brand) return res.status(404).json({ error: 'No brand profile found' });

  const data = JSON.parse(brand.data);
  const checklist = JSON.parse(brand.checklist || '{}');
  const simulation = scoreBrand(data, checklist);

  // Attempt real queries if any API key is configured
  const hasRealKeys = process.env.PERPLEXITY_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  let realResults = null;
  if (hasRealKeys) {
    realResults = await runRealMeasurement(brand);
  }

  const mid = crypto.randomUUID();
  const mtype = hasRealKeys ? 'api' : 'simulation';
  db.prepare(`
    INSERT INTO measurements (id, brand_id, score, breakdown, platform_scores, keyword_scores, baseline, after_score, measurement_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mid, brand.id, simulation.score, JSON.stringify(simulation.breakdown),
    JSON.stringify(simulation.platformScores), JSON.stringify(simulation.keywordScores),
    simulation.baseline, simulation.afterMention, mtype);

  res.json({ measurement: simulation, realResults, measurementType: mtype });
});

// ─── Scheduled daily measurements (8 AM UTC) ─────────────────────────────────

cron.schedule('0 8 * * *', () => {
  console.log('[cron] Running daily brand measurements…');
  const brands = db.prepare('SELECT * FROM brands').all();
  let count = 0;
  for (const brand of brands) {
    try {
      const data = JSON.parse(brand.data);
      const checklist = JSON.parse(brand.checklist || '{}');
      const m = scoreBrand(data, checklist);
      const mid = crypto.randomUUID();
      db.prepare(`
        INSERT INTO measurements (id, brand_id, score, breakdown, platform_scores, keyword_scores, baseline, after_score, measurement_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simulation')
      `).run(mid, brand.id, m.score, JSON.stringify(m.breakdown),
        JSON.stringify(m.platformScores), JSON.stringify(m.keywordScores),
        m.baseline, m.afterMention);
      count++;
    } catch (e) {
      console.error(`[cron] Failed brand ${brand.id}:`, e.message);
    }
  }
  console.log(`[cron] Done — measured ${count} brands`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nAgentic Shelf backend running on http://localhost:${PORT}`);
  console.log(`Serving frontend from: ${path.join(__dirname, '..')}`);
  console.log(`Database: ${DB_PATH}\n`);
});
