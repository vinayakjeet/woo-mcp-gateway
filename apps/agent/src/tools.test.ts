import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { clip, resultText, toFunctionTools } from './tools.js';

const tool = (t: Record<string, unknown>) => t as unknown as Tool;

describe('toFunctionTools', () => {
  it('uses the exposed name, the description as given and the schema without $schema', () => {
    const input = tool({
      name: 'main__list_orders',
      description: 'List orders.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { date: { type: 'string', enum: ['today'] } },
        additionalProperties: false,
      },
    });
    expect(toFunctionTools([input])).toEqual([
      {
        type: 'function',
        function: {
          name: 'main__list_orders',
          description: 'List orders.',
          parameters: {
            type: 'object',
            properties: { date: { type: 'string', enum: ['today'] } },
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(input.inputSchema).toHaveProperty('$schema');
  });

  it('leaves parameters out for a tool without arguments and defaults the description', () => {
    const input = [
      tool({ name: 'fx__get_info', inputSchema: { type: 'object', properties: {} } }),
      tool({ name: 'x__y', inputSchema: { type: 'object' } }),
    ];
    expect(toFunctionTools(input)).toEqual([
      { type: 'function', function: { name: 'fx__get_info', description: '' } },
      { type: 'function', function: { name: 'x__y', description: '' } },
    ]);
  });
});

describe('resultText and clip', () => {
  it('joins the text content with the structured content', () => {
    expect(
      resultText({
        content: [{ type: 'text', text: '2 orders' }],
        structuredContent: { orders: [{ id: 1 }] },
      }),
    ).toBe('2 orders\n{"orders":[{"id":1}]}');
  });

  it('keeps an error text and says when there is no output', () => {
    expect(
      resultText({ content: [{ type: 'text', text: 'upstream_error: down' }], isError: true }),
    ).toBe('upstream_error: down');
    expect(resultText({ content: [{ type: 'image' }] })).toBe('(no output)');
  });

  it('clips long text and says how much was cut', () => {
    expect(clip('abcdef', 4)).toBe('abcd\n[truncated 2 characters]');
    expect(clip('abc', 4)).toBe('abc');
  });
});
