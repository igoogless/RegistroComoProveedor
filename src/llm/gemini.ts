import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import type { LlmAdapter, LlmTurn, ToolDefinition } from "./adapter.js";

export class GeminiAdapter implements LlmAdapter {
  provider = "gemini";
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, public model: string, private readonly prompt: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async enviar(history: unknown[], tools: ToolDefinition[]): Promise<LlmTurn> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: history as Content[],
      config: {
        systemInstruction: this.prompt,
        tools: [{ functionDeclarations: tools.map(toDeclaration) }],
      },
    });
    return toTurn(response);
  }

  async responderHerramientas(history: unknown[], toolResults: { id: string; name: string; response: Record<string, unknown> }[], tools: ToolDefinition[]): Promise<LlmTurn> {
    const contents = [
      ...(history as Content[]),
      { role: "user", parts: toolResults.map((result) => ({ functionResponse: { id: result.id, name: result.name, response: result.response } })) },
    ];
    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: { systemInstruction: this.prompt, tools: [{ functionDeclarations: tools.map(toDeclaration) }] },
    });
    return toTurn(response);
  }
}

function toDeclaration(tool: ToolDefinition): FunctionDeclaration {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema };
}

function toTurn(response: { text?: string; functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[]; candidates?: { content?: Content }[]; usageMetadata?: { totalTokenCount?: number } }): LlmTurn {
  const calls = response.functionCalls ?? [];
  return {
    text: response.text ?? "",
    toolRequests: calls.flatMap((call, index) => call.name ? [{ id: call.id ?? `call-${index}`, name: call.name, input: call.args ?? {} }] : []),
    nativeResponse: response.candidates?.[0]?.content ?? { role: "model", parts: [] satisfies Part[] },
    tokens: response.usageMetadata?.totalTokenCount ?? 0,
  };
}
