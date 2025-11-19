import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config(); // .env einlesen

const app = express();
app.use(cors());
app.use(express.json());

// OpenAI-Client (API-Key aus .env)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post("/api/analyze-job-ad", async (req, res) => {
  try {
    const { jobText } = req.body;

    if (!jobText || typeof jobText !== "string") {
      return res.status(400).json({ error: "jobText fehlt oder ist ungültig." });
    }

    const prompt = `
Du bist ein Senior-Recruiting-Experte und Texter für Stellenanzeigen im DACH-Markt.

Analysiere die folgende Stellenanzeige und liefere das Ergebnis STRICT im folgenden JSON-Format (ohne zusätzliche Erklärungen):

{
  "summary": "kurze Zusammenfassung in 2-3 Sätzen",
  "strengths": ["Stärke 1", "Stärke 2", "..."],
  "issues": ["Problem/Schwachstelle 1", "Problem 2", "..."],
  "suggestions": ["Konkreter Verbesserungsvorschlag 1", "Verbesserungsvorschlag 2", "..."],
  "improvedAd": "vollständig überarbeitete Stellenanzeige in moderner, gut lesbarer Sprache"
}

Kriterien:
- Zielgruppe: passende Sprache (Du/Sie je nach Text), klare Struktur
- Social-Media-Tauglichkeit (Hook, Lesbarkeit, Klarheit)
- Klarheit der Rolle, Aufgaben, Anforderungen und Benefits
- Attraktivität als Arbeitgeber
- Geschlechtsneutrale und diskriminierungsfreie Formulierungen (m/w/d)

Hier ist die Stellenanzeige:

"""${jobText}"""
`;

        // Chat Completion statt Responses API nutzen:
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini", // alternativ: "gpt-4o-mini"
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices?.[0]?.message?.content || "";

    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.error("JSON-Parse-Fehler:", e, raw);
      return res.status(500).json({
        error: "Die KI-Antwort konnte nicht als JSON gelesen werden.",
      });
    }

    const result = {
      summary: json.summary || "",
      strengths: json.strengths || [],
      issues: json.issues || [],
      suggestions: json.suggestions || [],
      improvedAd: json.improvedAd || "",
    };

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Interner Serverfehler bei der Analyse.",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
