import { callGemini } from "../utils/geminiClient.js";

export async function generateDDR(findings, validation) {

const prompt = `
You are a building diagnostics expert.

Using the inspection findings and thermal findings extracted from the uploaded documents,
generate a Detailed Diagnostic Report.

Return ONLY valid JSON in this structure:

{
 "property_issue_summary": "",
 "overall_severity": "",
 "area_observations":[
  {
   "area":"",
   "combined_issue":"",
   "inspection_evidence":"",
   "thermal_evidence":"",
   "temperature_reading":"",
   "severity":"",
   "severity_reasoning":"",
   "probable_root_cause":"",
   "recommended_action":"",
   "source_ids":[],
"images":[]
  }
 ],
 "root_causes":[],
 "severity_assessment":"",
 "recommended_actions":[],
 "additional_notes":"",
 "missing_information":[]
}

Rules:
- Use ONLY the provided findings
- Do NOT invent information
- If something missing write "Not Available"

Findings:
${JSON.stringify(findings)}

Validation:
${JSON.stringify(validation)}
`;

const result = await callGemini(prompt);

const cleaned = result
  .replace(/```json/g, "")
  .replace(/```/g, "")
  .trim();

const json = JSON.parse(cleaned);
if (!Array.isArray(json.missing_information)) {
  json.missing_information = [json.missing_information].filter(Boolean);
}

// attach images back from findings
json.area_observations = (json.area_observations || []).map(obs => {

  const matched = findings.find(f =>
    f.area.toLowerCase().includes(obs.area.toLowerCase())
  );

  return {
    ...obs,
    images: matched?.images || []
  };

});

console.log("---- FINAL DDR ----");
console.log(json);


return json;
}