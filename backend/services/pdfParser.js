import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";

const uploadDir = path.join(process.cwd(), "uploads");

// ensure uploads folder exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

export async function parseDocuments(inspection, thermal) {

  async function extract(buffer, prefix) {

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer)
    });

    const pdf = await loadingTask.promise;

    let text = "";
    const images = [];

    for (let i = 1; i <= pdf.numPages; i++) {

      const page = await pdf.getPage(i);

      // -------- TEXT EXTRACTION --------
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(" ");
      text += pageText + "\n";

      // -------- IMAGE EXTRACTION --------
      const ops = await page.getOperatorList();

      for (let j = 0; j < ops.fnArray.length; j++) {

        const fn = ops.fnArray[j];

        // image operator
        if (fn === pdfjs.OPS.paintImageXObject) {

          const imgName = ops.argsArray[j][0];

          try {

            const img = await page.objs.get(imgName);

            const fileName = `${prefix}_p${i}_${j}.png`;
            const filePath = path.join(uploadDir, fileName);
            
            fs.writeFileSync(filePath, Buffer.from(img.data.buffer));
            
            images.push({
              id: `${prefix}_${i}_${j}`,
              file: fileName,
              page: i,
              source: prefix,
              context: pageText.toLowerCase()
            });
            
          } catch (err) {
            // ignore extraction errors
          }
        }
      }
    }

    return { text, images };
  }

  const inspectionData = await extract(inspection.buffer, "inspection");
  const thermalData = await extract(thermal.buffer, "thermal");

  return {
    inspectionText: inspectionData.text,
    thermalText: thermalData.text,
    images: [
      ...inspectionData.images,
      ...thermalData.images
    ]
  };
}