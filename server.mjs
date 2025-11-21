import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// JSON-Schema für die Responses API
const analysisSchema = {
  name: "job_ad_analysis",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      strengths: {
        type: "array",
        items: { type: "string" },
      },
      issues: {
        type: "array",
        items: { type: "string" },
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
      },
      improvedAd: { type: "string" },
      score: {
        type: "object",
        properties: {
          overall: { type: "number" },
          clarity: { type: "number" },
          attractiveness: { type: "number" },
          structure: { type: "number" },
          social_media_effectiveness: { type: "number" },
        },
        required: ["overall"],
        additionalProperties: false,
      },
    },
    required: [
      "summary",
      "strengths",
      "issues",
      "suggestions",
      "improvedAd",
      "score",
    ],
    additionalProperties: false,
  },
  strict: true,
};

// Hilfsfunktion: Text analysieren (Responses API)
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

Gib die Antwort STRICT im JSON-Format des Schema aus. Keine zusätzlichen Felder.
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
    response_format: {
      type: "json_schema",
      json_schema: analysisSchema,
    },
  });

  const rawText =
    response.output?.[0]?.content?.[0]?.text ??
    response.output_text ??
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

// 1) Analyse über direkten Text
app.post("/api/analyze-job-ad", async (req, res) => {
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
app.post("/api/analyze-job-ad-from-url", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== "string") {
      return res
        .status(400)
        .json({ error: "url fehlt oder ist ungültig." });
    }

    let response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (fetchErr) {
      console.error("Fetch-Fehler:", fetchErr);
      return res
        .status(500)
        .json({ error: "Die Seite konnte nicht geladen werden." });
    }

    if (!response.ok) {
      return res.status(500).json({
        error: `Die Seite konnte nicht geladen werden (HTTP ${response.status}).`,
      });
    }

    const html = await response.text();

    const result = await analyzeJobAdText(html, {
      source: `HTML von ${url}`,
    });

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
