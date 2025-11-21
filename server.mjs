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
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: userPrompt
      }
    ],

    // ⭐ NEUE Responses API Syntax ⭐
    format: {
      type: "json_schema",
      json_schema: analysisSchema
    }
  });

  // Responses API Rückgabeformat
  const rawText =
    response.output_text ??
    response.output?.[0]?.content?.[0]?.text ??
    "";

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    console.error("JSON-Parse-Fehler:", err, rawText);
    throw new Error("Die KI-Antwort konnte nicht als JSON verarbeitet werden.");
  }

  return {
    summary: json.summary ?? "",
    strengths: json.strengths ?? [],
    issues: json.issues ?? [],
    suggestions: json.suggestions ?? [],
    improvedAd: json.improvedAd ?? "",
    score: json.score ?? {}
  };


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

    // HTML auf sinnvolle Länge kürzen (z. B. 50.000 Zeichen),
    // damit OpenAI nicht mit zu viel Markup zugemüllt wird
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
