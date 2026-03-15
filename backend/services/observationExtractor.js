import { callGemini } from "../utils/geminiClient.js";

export async function extractObservations(inspectionText, thermalText) {

  const prompt = `
You are a professional building inspection analyst.

From the following inspection report and thermal report extract structured observations.

Return ONLY a JSON array.

Each observation must follow this structure:

[
 {
  "area": "",
  "issue_description": "",
  "cause_analysis": "",
  "evidence": "",
  "temperature_reading": "",
  "source": "inspection | thermal | both",
  "severity": "Low | Medium | High"
 }
]

Rules:
- Extract at least 5 observations
- If temperature values like 23.4°C, 22°C etc appear in the thermal report,
  include them in "temperature_reading"
- If no temperature is present return "Not Available"
- Use inspection report as main evidence
- Use thermal report for hidden moisture or anomalies
- Never return empty array
- Do not include markdown

Inspection Report:
${inspectionText}

Thermal Report:
${thermalText}
`;

  const result = await callGemini(prompt);

  const cleaned = result
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  const observations = JSON.parse(cleaned);

  return observations.map(obs => ({
    ...obs,
    images: []
  }));
}