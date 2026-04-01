import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface SignatureDetection {
  name: string;
  row_bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] - the entire row area
  signature_bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] - the specific signature area within the row
}

export async function detectSignatures(base64Image: string): Promise<SignatureDetection[]> {
  const model = "gemini-3.1-pro-preview";
  
  const prompt = `This is a page from a document containing a table of names and signatures. 
Please detect all rows in the table. For each row, provide:
1. The full name.
2. The bounding box of the ENTIRE row area. 
   IMPORTANT: Make this box TALLER than the actual row to ensure signatures that cross the table lines are fully captured.
3. The bounding box of ONLY the signature area within that row.
   IMPORTANT: Try to exclude table borders/lines from this box if possible.

Return a JSON array of objects with 'name', 'row_bbox', and 'signature_bbox' (all normalized 0-1000: [ymin, xmin, ymax, xmax]).
Do not include the header row.`;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image,
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            row_bbox: {
              type: Type.ARRAY,
              items: { type: Type.NUMBER },
              minItems: 4,
              maxItems: 4,
            },
            signature_bbox: {
              type: Type.ARRAY,
              items: { type: Type.NUMBER },
              minItems: 4,
              maxItems: 4,
            },
          },
          required: ["name", "row_bbox", "signature_bbox"],
        },
      },
    },
  });

  try {
    const text = response.text;
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return [];
  }
}
