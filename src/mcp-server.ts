import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as http from "http";
import { PromptCompressor, AstCompressor, ReverseMapper, CacheSimulator, KnowledgeGraph } from 'diettoken-core';
import * as path from "path";
import * as fs from "fs";

let enc: any = null;
function countTokens(text: string): number {
    if (!text) return 0;
    try {
        if (!enc) {
            const { encodingForModel } = require("js-tiktoken");
            enc = encodingForModel("gpt-4o");
        }
        return enc.encode(text).length;
    } catch (e) {
        // Fallback to heuristic if js-tiktoken is missing or fails
        return Math.ceil(text.length / 4);
    }
}

// Initialize singleton resources
const reverseMapper = new ReverseMapper();
const astCompressor = new AstCompressor(reverseMapper);
const cacheSimulator = CacheSimulator.getInstance();

function reportSavingsToProxy(
    originalTokens: number,
    compressedTokens: number,
    toolName: string,
    cacheSimTokens: number = 0,
    cacheSimDollars: number = 0
) {
    const payload = JSON.stringify({
        originalTokens,
        compressedTokens,
        cacheSimTokens,
        cacheSimDollars,
        client: 'Antigravity (MCP)',
        model: toolName
    });

    const ports = [8080, 8081, 8082, 8083, 8084, 8085];
    const tryPort = (index: number) => {
        if (index >= ports.length) return;
        const req = http.request({
            hostname: '127.0.0.1',
            port: ports[index],
            path: '/internal/report-savings',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        });
        req.on('error', () => tryPort(index + 1));
        req.write(payload);
        req.end();
    };
    tryPort(0);
}

async function init() {
  const kg = KnowledgeGraph.getInstance();
  await kg.initialize(path.join(__dirname, '..'));

  const server = new Server(
    {
      name: "diettoken-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "compress_prompt",
          description: "Compresses a conversational prompt by removing filler words and redundant phrases.",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The prompt text to compress",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "compress_ast",
          description: "Compresses source code by removing comments and unnecessary whitespace while protecting critical syntax.",
          inputSchema: {
            type: "object",
            properties: {
              sourceCode: {
                type: "string",
                description: "The source code to compress",
              },
              mode: {
                type: "string",
                enum: ["full", "skeleton"],
                description: "Compression mode: 'full' or 'skeleton'",
              },
              filePath: {
                type: "string",
                description: "Optional file path for Cavemem deduplication",
              },
            },
            required: ["sourceCode", "mode"],
          },
        },
        {
          name: "expand_tokens",
          description: "Expands short tokens back to their original long identifiers. Should be used on responses from the LLM.",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text containing shortened tokens",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "get_function_slice",
          description: "Extracts only a specific function and its direct callees from a file. Use instead of compress_ast when you know which function is relevant. Saves up to 80% more tokens than file-level skeletonization.",
          inputSchema: {
            type: "object",
            properties: {
              filePath: {
                type: "string",
                description: "Absolute path to the source file",
              },
              functionName: {
                type: "string",
                description: "The exact name of the function or method to extract",
              },
            },
            required: ["filePath", "functionName"],
          },
        }
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case "compress_prompt": {
        const text = request.params.arguments?.text as string;
        if (!text) throw new Error("Missing required argument: text");
        const compressed = PromptCompressor.compress(text);
        
        reportSavingsToProxy(countTokens(text), countTokens(compressed), "compress_prompt");
        
        return {
          content: [
            {
              type: "text",
              text: compressed,
            },
          ],
        };
      }
      case "compress_ast": {
        const sourceCode = request.params.arguments?.sourceCode as string;
        const mode = request.params.arguments?.mode as "full" | "skeleton" | undefined;
        const filePath = request.params.arguments?.filePath as string | undefined;
        const model = request.params.arguments?.model as string | undefined;

        if (!sourceCode) throw new Error("Missing required argument: sourceCode");

        const compressed = await astCompressor.compress(sourceCode, mode, filePath);
        const originalTokens = countTokens(sourceCode);
        const compressedTokens = countTokens(compressed);

        // Shadow Simulator: check if this payload is a provider cache hit
        const payloadHash = cacheSimulator.hashPayload(compressed);
        const isHit = cacheSimulator.checkAndRecord(payloadHash, model || 'default');
        let cacheSimTokens = 0;
        let cacheSimDollars = 0;
        if (isHit) {
          const simResult = cacheSimulator.estimateSavings(compressedTokens, model || 'default');
          cacheSimTokens = simResult.estimatedTokensSaved;
          cacheSimDollars = simResult.estimatedDollarsSaved;
        }

        reportSavingsToProxy(originalTokens, compressedTokens, `compress_ast (${mode || 'auto'})`, cacheSimTokens, cacheSimDollars);

        return {
          content: [
            {
              type: "text",
              text: compressed,
            },
          ],
        };
      }
      case "expand_tokens": {
        const text = request.params.arguments?.text as string;
        if (!text) throw new Error("Missing required argument: text");

        const expanded = reverseMapper.expand(text);
        return {
          content: [
            {
              type: "text",
              text: expanded,
            },
          ],
        };
      }
      case "get_function_slice": {
        const filePath = request.params.arguments?.filePath as string;
        const functionName = request.params.arguments?.functionName as string;
        if (!filePath || !functionName) throw new Error("Missing required arguments: filePath, functionName");

        try {
          const originalCode = await fs.promises.readFile(filePath, 'utf-8');
          const graph = KnowledgeGraph.getInstance();
          await graph.updateFileNode(filePath, originalCode);

          const slice = graph.getFunctionSlice(filePath, functionName, originalCode);
          const originalTokens = countTokens(originalCode);
          const sliceTokens = countTokens(slice);
          reportSavingsToProxy(originalTokens, sliceTokens, 'get_function_slice');

          return {
            content: [
              {
                type: "text",
                text: slice || `[DietToken] Function '${functionName}' not found in ${filePath}. Falling back to skeleton.`,
              },
            ],
          };
        } catch (e: any) {
          throw new Error(`get_function_slice failed: ${e.message}`);
        }
      }
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DietToken MCP server running on stdio");
}

init().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
