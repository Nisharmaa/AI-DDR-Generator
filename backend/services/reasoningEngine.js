import { callGemini } from "../utils/geminiClient.js";

export async function runReasoning(observations) {

  // Ensure each observation keeps images
  const mergedObservations = observations.map(o => ({
    ...o,
    images: o.images || o.related_images || []
  }));

  const prompt = `
You are a building diagnostics expert.

Merge and analyze the following observations from inspection and thermal reports.

Rules:
- Keep the observation areas.
- Merge duplicate issues.
- Preserve image references if present.
- Return ONLY a valid JSON array.

Observations:
${JSON.stringify(mergedObservations)}
`;

  const result = await callGemini(prompt);

  const cleaned = result
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleaned);
}