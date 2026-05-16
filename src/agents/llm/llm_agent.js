import "dotenv/config";
import OpenAI from "openai";


const baseURL = process.env.LLM_BASE_URL;
const apiKey = process.env.LLM_API_KEY;
const MODEL = process.env.MODEL_NAME;

if (!apiKey) {
  console.error("Error: missing LITELLM_API_KEY in .env file");
  process.exit(1);
}

// ==========================================
// 2. OpenAI-compatible client
// ==========================================

const client = new OpenAI({
  baseURL,
  apiKey,
});

// ==========================================
// 3. First LLM call
// ==========================================

const response = await client.chat.completions.create({
  model: MODEL,
  messages: [
    {
      role: "user",
      content: "Explain the defference between an LLM and an LLM-based agentic AI system in one sentence.",
    },
  ],
  temperature: 0.1,
});

console.log(response.choices[0].message.content);