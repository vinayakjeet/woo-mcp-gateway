import type { Tool } from '@modelcontextprotocol/client';

export type FunctionTool = {
  type: 'function';
  function: { name: string; description: string; parameters?: Record<string, unknown> };
};

export type ToolResultLike = {
  content?: ReadonlyArray<{ type: string; text?: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
};

export const PREVIEW_CHARS = 500;
export const TOOL_TEXT_MAX = 6000;

export function toFunctionTools(tools: Tool[]): FunctionTool[] {
  return tools.map((t) => {
    // $schema names a dialect and constrains nothing; strict providers reject unknown top-level keys.
    const schema: Record<string, unknown> = { ...t.inputSchema };
    delete schema.$schema;
    const props = schema.properties;
    const noArgs =
      props === undefined ||
      (typeof props === 'object' && props !== null && Object.keys(props).length === 0);
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        // Gemini has rejected object schemas with an empty properties map. No parameters means the same.
        ...(noArgs ? {} : { parameters: schema }),
      },
    };
  });
}

export function resultText(r: ToolResultLike): string {
  const parts = (r.content ?? []).flatMap((c) =>
    c.type === 'text' && typeof c.text === 'string' ? [c.text] : [],
  );
  // woo-mcp puts a one-line summary in content and the rows in structuredContent: the model needs both.
  if (r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n') || '(no output)';
}

export function clip(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;
}
