export type ToolDefinition = { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
export type ToolRequest = { id: string; name: string; input: Record<string, unknown> };
export type LlmTurn = { text: string; toolRequests: ToolRequest[]; nativeResponse: unknown; tokens: number };

export interface LlmAdapter {
  enviar(history: unknown[], tools: ToolDefinition[]): Promise<LlmTurn>;
  responderHerramientas(history: unknown[], toolResults: { id: string; name: string; response: Record<string, unknown> }[], tools: ToolDefinition[]): Promise<LlmTurn>;
  provider: string;
  model: string;
}
