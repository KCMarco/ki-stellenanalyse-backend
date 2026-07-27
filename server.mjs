import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM =
  process.env.RESEND_FROM ||
  "Kconsulting KI-Stellenanalyse <onboarding@resend.dev>";
const APP_LOGIN_URL =
  process.env.APP_LOGIN_URL ||
  "https://ki-stellenanalyse.webflow.io/login";
const APP_RESET_PASSWORD_URL =
  process.env.APP_RESET_PASSWORD_URL ||
  APP_LOGIN_URL.replace(/\/login\/?$/i, "/password");

const supabase =
  SUPABASE_URL && SUPABASE_SECRET_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const PLAN_INFO = {
  free: { name: "Free (Demo)", monthlyLimit: 3 },
  pro: { name: "Pro", monthlyLimit: 50 },
  enterprise: { name: "Enterprise", monthlyLimit: 350 },
};

function currentUsageMonth() {
  return new Date().toISOString().slice(0, 7);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateTemporaryPassword() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let password = "";
  for (let i = 0; i < 12; i += 1) {
    password += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return password;
}

function hashResetToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Nicht eingeloggt (Token fehlt)." });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    console.error("JWT-Fehler:", err);
    return res
      .status(401)
      .json({ error: "Ungültiger oder abgelaufener Token." });
  }
}

async function getUserById(userId) {
  if (!supabase || !userId) return null;

  const { data, error } = await supabase
    .from("users")
    .select(
      "id,email,password_hash,plan,analyses_used,usage_month,is_active,created_at"
    )
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getUserByEmail(email) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("users")
    .select(
      "id,email,password_hash,plan,analyses_used,usage_month,is_active,created_at"
    )
    .eq("email", email)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function refreshMonthlyUsage(user) {
  const month = currentUsageMonth();
  if (!user || user.usage_month === month) return user;

  const { data, error } = await supabase
    .from("users")
    .update({
      analyses_used: 0,
      usage_month: month,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select(
      "id,email,password_hash,plan,analyses_used,usage_month,is_active,created_at"
    )
    .single();

  if (error) throw error;
  return data;
}

async function requireActiveDatabaseUser(req, res) {
  if (req.user?.isAdmin) {
    return {
      id: null,
      email: req.user.email,
      plan: "enterprise",
      analyses_used: 0,
      usage_month: currentUsageMonth(),
      is_active: true,
      isAdmin: true,
    };
  }

  if (!supabase) {
    res.status(500).json({ error: "Benutzerdatenbank ist nicht konfiguriert." });
    return null;
  }

  let user = await getUserById(req.user?.userId);
  if (!user || !user.is_active) {
    res
      .status(401)
      .json({ error: "Benutzerkonto nicht gefunden oder deaktiviert." });
    return null;
  }

  user = await refreshMonthlyUsage(user);
  return user;
}

function usagePayload(user) {
  const planKey = PLAN_INFO[user.plan] ? user.plan : "free";
  const planInfo = PLAN_INFO[planKey];
  const used = Number(user.analyses_used || 0);

  return {
    plan: planKey,
    monthlyLimit: planInfo.monthlyLimit,
    remainingThisMonth: Math.max(0, planInfo.monthlyLimit - used),
  };
}

async function ensureUsageAvailable(req, res) {
  const user = await requireActiveDatabaseUser(req, res);
  if (!user) return null;
  if (user.isAdmin) return user;

  const planKey = PLAN_INFO[user.plan] ? user.plan : "free";
  const limit = PLAN_INFO[planKey].monthlyLimit;

  if (Number(user.analyses_used || 0) >= limit) {
    res.status(429).json({
      error: `Dein monatliches Analyse-Limit von ${limit} ist erreicht.`,
      usage: usagePayload(user),
    });
    return null;
  }

  return user;
}

async function incrementUsage(user) {
  if (!user || user.isAdmin) return user;

  const nextUsed = Number(user.analyses_used || 0) + 1;
  const { data, error } = await supabase
    .from("users")
    .update({
      analyses_used: nextUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", user.id)
    .select("id,email,plan,analyses_used,usage_month,is_active")
    .single();

  if (error) throw error;
  return data;
}

async function sendWelcomeEmail(email, temporaryPassword) {
  if (!resend) throw new Error("RESEND_API_KEY ist nicht konfiguriert.");

  const { error } = await resend.emails.send({
    from: RESEND_FROM,
    to: email,
    subject: "Dein Zugang zur KI-Stellenanalyse",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a;max-width:620px;margin:auto">
        <h2 style="color:#1776d4">Willkommen bei der Kconsulting KI-Stellenanalyse</h2>
        <p>Dein kostenloser Testzugang wurde erfolgreich erstellt.</p>
        <p><strong>E-Mail:</strong> ${email}</p>
        <p><strong>Vorläufiges Passwort:</strong></p>
        <div style="font-size:22px;font-weight:700;letter-spacing:2px;background:#eef6ff;border-radius:10px;padding:14px 18px;display:inline-block">${temporaryPassword}</div>
        <p>Damit stehen dir im Free-Plan bis zu <strong>3 Analysen pro Monat</strong> zur Verfügung.</p>
        <p><a href="${APP_LOGIN_URL}" style="display:inline-block;background:#1776d4;color:white;text-decoration:none;padding:12px 20px;border-radius:999px">Jetzt einloggen</a></p>
        <p style="font-size:12px;color:#64748b">Bitte bewahre dein Passwort sicher auf.</p>
      </div>
    `,
  });

  if (error) throw new Error(error.message || "E-Mail konnte nicht versendet werden.");
}

async function sendPasswordResetEmail(email, resetUrl) {
  if (!resend) throw new Error("RESEND_API_KEY ist nicht konfiguriert.");

  const { error } = await resend.emails.send({
    from: RESEND_FROM,
    to: email,
    subject: "Passwort für die KI-Stellenanalyse zurücksetzen",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a;max-width:620px;margin:auto">
        <h2 style="color:#1776d4">Passwort zurücksetzen</h2>
        <p>Für dein Konto bei der Kconsulting KI-Stellenanalyse wurde ein neues Passwort angefordert.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#1776d4;color:white;text-decoration:none;padding:12px 20px;border-radius:999px">Neues Passwort festlegen</a></p>
        <p>Der Link ist aus Sicherheitsgründen nur <strong>60 Minuten</strong> gültig und kann nur einmal verwendet werden.</p>
        <p style="font-size:12px;color:#64748b">Falls du kein neues Passwort angefordert hast, kannst du diese E-Mail ignorieren. Dein bisheriges Passwort bleibt gültig.</p>
      </div>
    `,
  });

  if (error) throw new Error(error.message || "Reset-E-Mail konnte nicht versendet werden.");
}

async function analyzeJobAdText(rawInput, options = {}) {
  const { source = "Direkter Text" } = options;

  const systemPrompt = `
Du bist ein Senior-Recruiting-Experte und Profi-Texter für Stellenanzeigen im DACH-Markt.

Du erhältst entweder:
- reinen Anzeigentext ODER
- HTML-Quelltext einer Webseite mit einer Stellenanzeige.

Deine Aufgaben:
1. Falls der Input HTML ist, extrahiere zuerst NUR die eigentliche Stellenanzeige (Titel, Intro, Aufgaben, Profil, Benefits etc.).
2. Analysiere anschließend:
   - Klarheit der Rolle
   - Struktur & Lesbarkeit
   - Attraktivität als Arbeitgeber
   - Eignung für Social Media
   - Zielgruppenansprache & Tonalität
3. Vergib Scores (0–100).
4. Erstelle eine komplett optimierte Version der Anzeige.

WICHTIG:
- Antworte AUSSCHLIESSLICH mit gültigem JSON.
- KEIN Fließtext außerhalb des JSON.
- KEIN Markdown, KEINE Erklärungen.
- Verwende GENAU dieses JSON-Format:

{
  "summary": "Kurz-Zusammenfassung der Anzeige.",
  "strengths": ["Punkt 1", "Punkt 2"],
  "issues": ["Punkt 1", "Punkt 2"],
  "suggestions": ["Punkt 1", "Punkt 2"],
  "improvedAd": "Vollständig überarbeitete Stellenanzeige als Fließtext.",
  "score": {
    "overall": 83,
    "clarity": 85,
    "attractiveness": 80,
    "structure": 82,
    "social_media_effectiveness": 84
  }
}

Halte dich strikt an diese Struktur. Alle Felder müssen vorhanden sein.
`;

  const userPrompt = `
Quelle: ${source}

Input:
"""${rawInput}"""
`;

  const response = await client.responses.create({
    model: "gpt-4.1",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const rawText =
    response.output_text ?? response.output?.[0]?.content?.[0]?.text ?? "";

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    console.error("JSON-Parse-Fehler:", err, rawText);
    throw new Error("Die KI-Antwort konnte nicht als JSON interpretiert werden.");
  }

  return {
    summary: json.summary || "",
    strengths: json.strengths || [],
    issues: json.issues || [],
    suggestions: json.suggestions || [],
    improvedAd: json.improvedAd || "",
    score: {
      overall: json.score?.overall ?? null,
      clarity: json.score?.clarity ?? null,
      attractiveness: json.score?.attractiveness ?? null,
      structure: json.score?.structure ?? null,
      social_media_effectiveness:
        json.score?.social_media_effectiveness ?? null,
    },
  };
}

app.get("/", (req, res) => {
  res.send("KI-Stellenanalyse Backend läuft.");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabaseConfigured: Boolean(supabase),
    emailConfigured: Boolean(resend),
    passwordResetConfigured: Boolean(supabase && resend),
  });
});

app.post("/api/signup", async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!isValidEmail(email)) {
    return res
      .status(400)
      .json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." });
  }

  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Registrierung ist aktuell nicht konfiguriert." });
  }

  try {
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        error:
          "Für diese E-Mail-Adresse besteht bereits ein Zugang. Bitte nutze den Login.",
      });
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);

    const { data: newUser, error: insertError } = await supabase
      .from("users")
      .insert({
        email,
        password_hash: passwordHash,
        plan: "free",
        analyses_used: 0,
        usage_month: currentUsageMonth(),
        is_active: true,
      })
      .select("id,email,plan")
      .single();

    if (insertError) throw insertError;

    try {
      await sendWelcomeEmail(email, temporaryPassword);
    } catch (emailError) {
      console.error("Willkommensmail fehlgeschlagen:", emailError);
      await supabase.from("users").delete().eq("id", newUser.id);
      return res.status(502).json({
        error:
          "Der Zugang konnte nicht per E-Mail zugestellt werden. Bitte versuche es später erneut.",
      });
    }

    return res.status(201).json({
      success: true,
      message: "Dein Passwort wurde per E-Mail versendet.",
      user: { email: newUser.email, plan: newUser.plan },
    });
  } catch (err) {
    console.error("Signup-Fehler:", err);
    return res
      .status(500)
      .json({ error: "Registrierung konnte nicht abgeschlossen werden." });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const genericResponse = {
    success: true,
    message:
      "Falls für diese E-Mail-Adresse ein aktiver Zugang besteht, wurde ein Link zum Zurücksetzen des Passworts versendet.",
  };

  if (!isValidEmail(email)) {
    return res
      .status(400)
      .json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." });
  }

  if (!supabase || !resend) {
    return res
      .status(500)
      .json({ error: "Passwort-Reset ist aktuell nicht konfiguriert." });
  }

  try {
    const user = await getUserByEmail(email);

    // Absichtlich dieselbe Antwort, damit niemand vorhandene Konten ermitteln kann.
    if (!user || !user.is_active) return res.json(genericResponse);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("users")
      .update({
        password_reset_token_hash: tokenHash,
        password_reset_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateError) throw updateError;

    const separator = APP_RESET_PASSWORD_URL.includes("?") ? "&" : "?";
    const resetUrl = `${APP_RESET_PASSWORD_URL}${separator}token=${encodeURIComponent(
      rawToken
    )}`;

    try {
      await sendPasswordResetEmail(email, resetUrl);
    } catch (emailError) {
      await supabase
        .from("users")
        .update({
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      throw emailError;
    }

    return res.json(genericResponse);
  } catch (err) {
    console.error("Forgot-Password-Fehler:", err);
    return res
      .status(500)
      .json({ error: "Der Reset-Link konnte nicht versendet werden." });
  }
});

app.post("/api/reset-password", async (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = String(req.body?.password || "");

  if (!token || !password) {
    return res
      .status(400)
      .json({ error: "Reset-Token und neues Passwort sind erforderlich." });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: "Das neue Passwort muss mindestens 8 Zeichen lang sein." });
  }

  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Passwort-Reset ist aktuell nicht konfiguriert." });
  }

  try {
    const tokenHash = hashResetToken(token);

    const { data: user, error: findError } = await supabase
      .from("users")
      .select("id,email,is_active,password_reset_expires_at")
      .eq("password_reset_token_hash", tokenHash)
      .maybeSingle();

    if (findError) throw findError;

    if (
      !user ||
      !user.is_active ||
      !user.password_reset_expires_at ||
      new Date(user.password_reset_expires_at).getTime() <= Date.now()
    ) {
      return res.status(400).json({
        error:
          "Der Reset-Link ist ungültig oder abgelaufen. Bitte fordere einen neuen Link an.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const { error: updateError } = await supabase
      .from("users")
      .update({
        password_hash: passwordHash,
        password_reset_token_hash: null,
        password_reset_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)
      .eq("password_reset_token_hash", tokenHash);

    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: "Dein Passwort wurde erfolgreich geändert. Du kannst dich jetzt einloggen.",
    });
  } catch (err) {
    console.error("Reset-Password-Fehler:", err);
    return res
      .status(500)
      .json({ error: "Das Passwort konnte nicht geändert werden." });
  }
});

app.post("/api/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res
      .status(400)
      .json({ error: "E-Mail und Passwort sind erforderlich." });
  }

  if (
    ADMIN_EMAIL &&
    ADMIN_PASSWORD &&
    email === ADMIN_EMAIL &&
    password === ADMIN_PASSWORD
  ) {
    const token = generateToken({ email, isAdmin: true });
    return res.json({
      token,
      user: { email, plan: "enterprise" },
    });
  }

  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Login ist aktuell nicht konfiguriert." });
  }

  try {
    let user = await getUserByEmail(email);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: "Ungültige Zugangsdaten." });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ error: "Ungültige Zugangsdaten." });
    }

    user = await refreshMonthlyUsage(user);
    const token = generateToken({ userId: user.id, email: user.email });

    return res.json({
      token,
      user: { email: user.email, plan: user.plan },
    });
  } catch (err) {
    console.error("Login-Fehler:", err);
    return res
      .status(500)
      .json({ error: "Login konnte nicht durchgeführt werden." });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = await requireActiveDatabaseUser(req, res);
    if (!user) return;

    const planKey = PLAN_INFO[user.plan] ? user.plan : "free";
    return res.json({
      user: { email: user.email },
      plan: planKey,
      planInfo: PLAN_INFO[planKey],
      analysesUsed: Number(user.analyses_used || 0),
      usageMonth: user.usage_month,
    });
  } catch (err) {
    console.error("/api/me-Fehler:", err);
    return res
      .status(500)
      .json({ error: "Benutzerdaten konnten nicht geladen werden." });
  }
});

app.post("/api/analyze-job-ad", authMiddleware, async (req, res) => {
  try {
    const user = await ensureUsageAvailable(req, res);
    if (!user) return;

    const { jobText } = req.body;
    if (!jobText || typeof jobText !== "string") {
      return res
        .status(400)
        .json({ error: "jobText fehlt oder ist ungültig." });
    }

    const result = await analyzeJobAdText(jobText.trim(), {
      source: "Direkt eingegebene Stellenanzeige",
    });

    const updatedUser = await incrementUsage(user);
    return res.json({ ...result, usage: usagePayload(updatedUser) });
  } catch (err) {
    console.error("Fehler in /api/analyze-job-ad:", err);
    return res
      .status(500)
      .json({ error: "Interner Serverfehler bei der Analyse." });
  }
});

app.post(
  "/api/analyze-job-ad-from-url",
  authMiddleware,
  async (req, res) => {
    try {
      const user = await ensureUsageAvailable(req, res);
      if (!user) return;

      const { url } = req.body;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "url fehlt oder ist ungültig." });
      }

      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({
          error:
            "Bitte gib eine vollständige URL inklusive http:// oder https:// an.",
        });
      }

      let response;
      try {
        response = await fetch(url, { redirect: "follow" });
      } catch (fetchErr) {
        console.error("Fetch-Fehler:", fetchErr);
        return res.status(500).json({
          error:
            "Die Seite konnte nicht geladen werden. Bitte probiere eine andere URL oder füge den Text direkt ein.",
        });
      }

      if (!response.ok) {
        return res.status(500).json({
          error: `Die Seite konnte nicht geladen werden (HTTP ${response.status}).`,
        });
      }

      const html = await response.text();
      const result = await analyzeJobAdText(html.slice(0, 50000), {
        source: `HTML von ${url}`,
      });

      const updatedUser = await incrementUsage(user);
      return res.json({ ...result, usage: usagePayload(updatedUser) });
    } catch (err) {
      console.error("Fehler in /api/analyze-job-ad-from-url:", err);
      return res
        .status(500)
        .json({ error: "Interner Serverfehler bei der URL-Analyse." });
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
