import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Login / JWT-Konfiguration
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";

// JWT erzeugen
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

// Middleware: prüft, ob ein gültiger Token mitgeschickt wurde
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Nicht eingeloggt (Token fehlt)." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // falls du später z. B. email brauchst
    next();
  } catch (err) {
    console.error("JWT-Fehler:", err);
    return res.status(401).json({ error: "Ungültiger oder abgelaufener Token." });
  }
}

// Hilfsfunktion: Text analysieren (Responses API, ohne response_format)
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
  "strengths": [
    "Punkt 1",
    "Punkt 2"
  ],
  "issues": [
    "Punkt 1",
    "Punkt 2"
  ],
  "suggestions": [
    "Punkt 1",
    "Punkt 2"
  ],
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
    response.output_text ??
    response.output?.[0]?.content?.[0]?.text ??
    "";

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

// Healthcheck
app.get("/", (req, res) => {
  res.send("KI-Stellenanalyse Backend läuft.");
});

// Login-Endpunkt: gibt bei korrekten Zugangsdaten einen JWT-Token zurück
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .json({ error: "Email und Passwort sind erforderlich." });
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ADMIN_EMAIL oder ADMIN_PASSWORD nicht gesetzt.");
    return res
      .status(500)
      .json({ error: "Login ist aktuell nicht konfiguriert." });
  }

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Ungültige Zugangsdaten." });
  }

  const token = generateToken({ email });
  res.json({ token });
});


// 1) Analyse über direkten Text
app.post("/api/analyze-job-ad", authMiddleware, async (req, res) => {
  try {
    const { jobText } = req.body;

    if (!jobText || typeof jobText !== "string") {
      return res
        .status(400)
        .json({ error: "jobText fehlt oder ist ungültig." });
    }

    const result = await analyzeJobAdText(jobText.trim(), {
      source: "Direkt eingegebene Stellenanzeige",
    });

    res.json(result);
  } catch (err) {
    console.error("Fehler in /api/analyze-job-ad:", err);
    res.status(500).json({
      error: "Interner Serverfehler bei der Analyse.",
    });
  }
});

// 2) Analyse über URL (HTML laden & analysieren)
app.post("/api/analyze-job-ad-from-url", authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== "string") {
      return res
        .status(400)
        .json({ error: "url fehlt oder ist ungültig." });
    }

    // Basic-Check: URL muss mit http(s) beginnen
    if (!/^https?:\/\//i.test(url)) {
      return res
        .status(400)
        .json({ error: "Bitte gib eine vollständige URL inkl. http(s) an." });
    }

    let response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (fetchErr) {
      console.error("Fetch-Fehler:", fetchErr);
      return res.status(500).json({
        error:
          "Die Seite konnte nicht geladen werden (Netzwerk-/SSL-Fehler). Bitte probiere eine andere URL oder füge den Text direkt ein.",
      });
    }

    if (!response.ok) {
      console.error("HTTP-Fehler beim Laden der URL:", response.status);
      return res.status(500).json({
        error: `Die Seite konnte nicht geladen werden (HTTP ${response.status}).`,
      });
    }

    let html;
    try {
      html = await response.text();
    } catch (readErr) {
      console.error("Fehler beim Lesen des HTML:", readErr);
      return res.status(500).json({
        error:
          "Der Inhalt der Seite konnte nicht gelesen werden. Bitte füge den Anzeigentext direkt ein.",
      });
    }

    // HTML auf sinnvolle Länge kürzen
    const trimmedHtml = html.slice(0, 50000);

    let result;
    try {
      result = await analyzeJobAdText(trimmedHtml, {
        source: `HTML von ${url}`,
      });
    } catch (aiErr) {
      console.error("OpenAI-/Analyse-Fehler:", aiErr);
      return res.status(500).json({
        error:
          "Die KI konnte die Stellenanzeige von dieser URL nicht verarbeiten. Bitte füge den Text direkt ein.",
      });
    }

    res.json(result);
  } catch (err) {
    console.error("Fehler in /api/analyze-job-ad-from-url:", err);
    res.status(500).json({
      error: "Interner Serverfehler bei der URL-Analyse.",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
