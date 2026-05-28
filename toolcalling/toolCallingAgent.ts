import { AGENT_TOOLS, AgentToolCall, executeAgentTool } from "./agentTools";

export interface ToolCallingAgentOptions {
  userPrompt: string;
  systemPrompt?: string;
  providerCall: (messages: any[], tools: any[]) => Promise<any>;
  maxToolRounds?: number;
}

export interface ToolCallingAgentResult {
  finalText: string;
  toolRounds: number;
  toolResults: any[];
}

export async function runToolCallingAgent({
  userPrompt,
  systemPrompt,
  providerCall,
  maxToolRounds = 6,
}: ToolCallingAgentOptions): Promise<ToolCallingAgentResult> {
  const messages: any[] = [
    {
      role: "system",
      content:
        systemPrompt ||
        `You are PunamIDE agent.

Use tools before asking for large context.

Rules:
- Never request full file unless truly needed.
- For line questions, call read_lines.
- For bug fixes, search_project or search_file first, then read_lines nearby.
- Prefer apply_patch over write_file.
- Do not rewrite whole files unless user explicitly asks.
- For files above 300 lines, use read_lines chunks.
- After tool results, answer clearly or apply minimal patch.`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];

  const allToolResults: any[] = [];

  for (let round = 0; round < maxToolRounds; round++) {
    const response = await providerCall(messages, AGENT_TOOLS);

    const toolCalls: AgentToolCall[] = normalizeToolCalls(response);

    if (!toolCalls.length) {
      return {
        finalText: extractText(response),
        toolRounds: round,
        toolResults: allToolResults,
      };
    }

    messages.push({
      role: "assistant",
      content: extractText(response) || "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const result = await executeAgentTool(toolCall);
      allToolResults.push(result);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id || toolCall.name,
        name: toolCall.name,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    finalText:
      "I reached the maximum tool-call rounds. I stopped to avoid loops. Please narrow the task or inspect the tool results.",
    toolRounds: maxToolRounds,
    toolResults: allToolResults,
  };
}

function normalizeToolCalls(response: any): AgentToolCall[] {
  const calls = response?.tool_calls || response?.toolCalls || [];

  return calls
    .map((call: any) => ({
      id: call.id,
      name: call.name || call.function?.name,
      arguments:
        typeof call.arguments === "string"
          ? safeJson(call.arguments)
          : typeof call.function?.arguments === "string"
            ? safeJson(call.function.arguments)
            : call.arguments || call.function?.arguments || {},
    }))
    .filter((x: any) => x.name);
}

function extractText(response: any): string {
  if (typeof response === "string") return response;
  if (response?.content) return response.content;
  if (response?.text) return response.text;
  if (response?.message?.content) return response.message.content;
  return "";
}

function safeJson(input: string): any {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}