import { GoogleGenAI, Type } from "@google/genai";

export interface SignatureDetection {
  name: string;
  username: string;
  row_bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] - the entire row area
  signature_bbox: [number, number, number, number]; // [ymin, xmin, ymax, xmax] - the specific signature area within the row
}

export async function checkApiKey(apiKey: string): Promise<boolean> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite-preview",
      contents: "ping",
    });
    return !!response.text;
  } catch (e) {
    console.error("API Key check failed", e);
    return false;
  }
}

export async function detectSignatures(base64Image: string, userApiKey?: string): Promise<SignatureDetection[]> {
  const apiKey = userApiKey || process.env.GEMINI_API_KEY || "";
  const ai = new GoogleGenAI({ apiKey });
  const model = "gemini-3.1-pro-preview";
  
  const prompt = `This is a page from a document containing a table of names, usernames, and signatures. 
Please detect all rows in the table. For each row, provide:
1. The full name (usually in a column like "Họ và tên").
2. The username (usually a short code like "AnhTN", "TuoiDT" in a separate column). 
   IMPORTANT: Preserve the exact casing (uppercase/lowercase) and any numbers.
3. The bounding box of the ENTIRE row area. 
   IMPORTANT: Make this box TALLER than the actual row to ensure signatures that cross the table lines are fully captured.
4. The bounding box of ONLY the signature area within that row.
   IMPORTANT: Try to exclude table borders/lines from this box if possible.

Return a JSON array of objects with 'name', 'username', 'row_bbox', and 'signature_bbox' (all normalized 0-1000: [ymin, xmin, ymax, xmax]).
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
            username: { type: Type.STRING },
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
          required: ["name", "username", "row_bbox", "signature_bbox"],
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
