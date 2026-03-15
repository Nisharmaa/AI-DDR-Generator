import express from "express";
import multer from "multer";
import path from "path";

import { parseDocuments } from "../services/pdfParser.js";
import { extractObservations } from "../services/observationExtractor.js";
import { mapImages } from "../services/imageMapper.js";
import { runReasoning } from "../services/reasoningEngine.js";
import { validateData } from "../services/validator.js";
import { generateDDR } from "../services/reportGenerator.js";

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

router.post(
  "/process",
  upload.fields([
    { name: "inspection" },
    { name: "thermal" }
  ]),
  async (req, res) => {
    try {
      const inspection = req.files["inspection"][0];
      const thermal = req.files["thermal"][0];

      // PARSE DOCUMENTS
      const { inspectionText, thermalText, images } =
        await parseDocuments(inspection, thermal);
        global.images = images;
        
        console.log("---- PARSE STAGE ----");
console.log("Inspection text length:", inspectionText.length);
console.log("Thermal text length:", thermalText.length);
console.log("Images extracted:", images.length);

      // EXTRACT OBSERVATIONS
      const observations = await extractObservations(
        inspectionText,
        thermalText
      );
      console.log("---- OBSERVATIONS ----");
      console.log(observations);
      console.log("Observation count:", observations?.length);

      // MAP IMAGES
      const mapped = await mapImages(observations, images);
console.log("---- IMAGE MAPPING ----");
console.log(mapped);

      // REASONING
      const merged = await runReasoning(mapped);
      console.log("---- MERGED FINDINGS ----");
console.log(merged);

      // VALIDATION
      const validation = await validateData(merged);

      // GENERATE DDR
      // GENERATE DDR
const report = await generateDDR(merged, validation);

// attach images to each observation
report.area_observations = report.area_observations.map(obs => {
  const relatedImages = images.filter(img =>
    (obs.source_ids || []).some(id => String(id) === String(img.id))
  );

  return {
    ...obs,
    images: relatedImages
  };
});

      res.json({
        report,
        validation,
        images
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);


router.get("/image/:id", (req, res) => {
  console.log("Requested image:", req.params.id);
  console.log("Available images:", global.images);

  const img = global.images.find(i => String(i.id) === String(req.params.id));

  if (!img) {
    return res.status(404).send("Image not found");
  }

  const filePath = path.join(process.cwd(), "uploads", img.file);

  res.sendFile(filePath);

});
export default router;