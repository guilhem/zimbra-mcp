import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { SafeError, safeErrorText } from './zimbra.ts';
import type { Env, FetchImpl, SoapObject } from './zimbra.ts';

z.config({ jitless: true });

export function defineTool<Shape extends z.ZodRawShape>(name: string, description: string,
  schema: z.ZodObject<Shape, z.core.$strict>, annotations: ToolAnnotations,
  run: (args: z.output<z.ZodObject<Shape, z.core.$strict>>, env: Env, fetchImpl: FetchImpl) => Promise<SoapObject>) {
  async function execute(args: unknown, env: Env, fetchImpl: FetchImpl): Promise<CallToolResult> {
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new SafeError('INVALID_ARGUMENTS');
    const result = await run(parsed.data, env, fetchImpl);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false };
  }
  return Object.freeze({
    name, description, schema, annotations,
    inputSchema: z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }),
    execute,
    register(server: McpServer, env: Env, fetchImpl: FetchImpl): void {
      server.registerTool<z.ZodRawShape, typeof schema>(name, { description, inputSchema: schema, annotations }, async args => {
        try { return await execute(args, env, fetchImpl); }
        catch (error) { return { isError: true, content: [{ type: 'text', text: safeErrorText(error) }] }; }
      });
    },
  });
}
