import { callGemini } from "../utils/geminiClient.js";

export async function mapImages(observations, images) {

console.log("Images received:", images);

const imageList = images.map(img => ({
  id: img.id,
  page: img.page,
  context: img.context?.slice(0,200) || ""
})).slice(0,20);

const prompt = `
Match inspection observations with extracted images.

Observations:
${JSON.stringify(observations, null, 2)}

Images:
${JSON.stringify(imageList, null, 2)}

Rules:
- Match images using page number and context.
- Return most relevant image ids.
- If none match return empty array.

Return JSON only.

Format:
[
  { "area":"Hall", "images":["inspection_1_10","thermal_2_5"] }
]
`;

const result = await callGemini(prompt);

const cleaned = result
.replace(/```json/g,"")
.replace(/```/g,"")
.trim();

const mapping = JSON.parse(cleaned);

return observations.map(obs => {

const found = mapping.find(
m => obs.area.toLowerCase().includes(m.area.toLowerCase())
);

return {
...obs,

images: found ? found.images : []
};

});

}