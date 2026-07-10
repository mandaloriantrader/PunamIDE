// src/components/chat/context/identityResponses.ts
//
// Pure function for handling identity/greeting responses.
// No React state, no hooks — only string logic.

export function getIdentityResponse(text: string): string | null {
  const lower = text.toLowerCase().replace(/[?!.,]/g, "").trim();

  // Exact-match greetings (only fire if the ENTIRE message is just a greeting)
  const exactGreetings = ["hello", "hi", "hey", "hey punam", "hi punam", "hello punam"];
  const isExactGreeting = exactGreetings.includes(lower);

  // Phrase-match identity questions (can appear within longer text)
  const identityPhrases = [
    "who are you", "what are you", "whats your name", "what is your name",
    "your name", "introduce yourself", "tell me about yourself",
    "who made you", "who created you", "who built you", "who developed you",
    "who is your creator", "who is your developer", "who designed you",
    "are you ai", "are you a bot", "are you human",
  ];

  // "what can you do" only if it's the main intent (short message)
  const isCapabilityQuestion = (lower.includes("what can you do") || lower.includes("what do you do") || lower.includes("how do you work")) && lower.length < 40;

  const isIdentityQuestion = identityPhrases.some((trigger) => lower.includes(trigger));

  if (!isExactGreeting && !isIdentityQuestion && !isCapabilityQuestion) return null;

  if (lower.includes("who made") || lower.includes("who created") || lower.includes("who built") || lower.includes("who developed") || lower.includes("creator") || lower.includes("developer") || lower.includes("designed")) {
    return "I was created and developed by **Amritanshu Amar**. He designed me to be an intelligent, AI-powered coding assistant that helps developers write, edit, and manage code through natural language — all from within a sleek desktop IDE.";
  }

  if (lower.includes("what can you do") || lower.includes("what do you do") || lower.includes("how do you work")) {
    return "I'm **Punam**, your AI-powered coding assistant! I was created by **Amritanshu Amar**.\n\nHere's what I can do:\n\n• **Edit & create files** — describe what you want in plain English and I'll generate the code changes\n• **Understand your project** — I can see your file tree and understand the structure\n• **Multi-language support** — Python, JavaScript, TypeScript, Rust, Go, Java, and many more\n• **Run commands** — I can suggest terminal commands to run\n• **Debug & fix** — describe a bug and I'll find and fix it\n\nJust type what you need!";
  }

  if (isExactGreeting) {
    return "Hey there! I'm **Punam**, your AI coding assistant created by **Amritanshu Amar**. I'm here to help you write, edit, and manage your code. Just tell me what you need — describe it in plain English and I'll take care of the rest!";
  }

  return "Hi! I'm **Punam** — an AI-powered coding assistant built right into this IDE. I was created and developed by **Amritanshu Amar**.\n\nI help you write, modify, and debug code using natural language. Just describe what you want — like \"add a login page\" or \"fix the error in main.py\" — and I'll generate the exact code changes, show you a preview, and apply them when you're ready.\n\nI support multiple AI providers (Google Gemini, OpenAI, OpenRouter, Groq, Mistral AI, Ollama) and work with any programming language. Think of me as your personal coding partner!";
}
