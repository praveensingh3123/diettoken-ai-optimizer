import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ReverseMapper, AstCompressor, KnowledgeGraph, PromptCompressor } from 'diettoken-core';
import { SavingsTracker } from '../tracker/SavingsTracker';
import * as fs from 'fs';
import * as path from 'path';

export class ProxyServer {
    private server: http.Server | null = null;
    private port: number = 0;
    private reverseMapper: ReverseMapper;
    private astCompressor: AstCompressor;
    private upstreamUrl: string = 'https://api.openai.com/v1/chat/completions';

    constructor() {
        this.reverseMapper = new ReverseMapper();
        this.astCompressor = new AstCompressor(this.reverseMapper);
    }

    public setUpstreamUrl(url: string) {
        this.upstreamUrl = url;
    }

    /**
     * Starts the local Node.js HTTP server. Includes dynamic port-checking 
     * to prevent conflicts if port 8080 is already used.
     */
    public async start(desiredPort: number = 8080): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(this.handleRequest.bind(this));
            
            this.server.on('error', (e: any) => {
                if (e.code === 'EADDRINUSE') {
                    console.log(`Port ${desiredPort} in use, trying ${desiredPort + 1}...`);
                    this.server?.listen(desiredPort + 1, '127.0.0.1');
                } else {
                    reject(e);
                }
            });

            this.server.on('listening', () => {
                this.port = (this.server?.address() as import('net').AddressInfo).port;
                resolve(this.port);
            });

            this.server.listen(desiredPort, '127.0.0.1');
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        if (req.method === 'POST' && req.url === '/mcp') {
            return this.handleMcpRequest(req, res);
        }

        // Add internal endpoint for reporting savings from standalone MCP servers
        if (req.method === 'POST' && req.url === '/internal/report-savings') {
            return this.handleReportSavings(req, res);
        }

        // Fallback for non-LLM API calls or unsupported methods
        if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
            return this.bypassRequest(req, res);
        }

        // Senior Edge Case: Large Payload Management
        // If the developer sends a massive file in the prompt, avoid loading entirely into RAM at once if possible.
        // For the proxy, we accumulate chunks, but a production version might stream directly into the parser.
        const chunks: Buffer[] = [];
        let totalSize = 0;
        const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50 MB limit

        req.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_PAYLOAD_SIZE) {
                req.destroy(new Error("Payload too large"));
                return;
            }
            chunks.push(chunk);
        });
        
        req.on('end', async () => {
            const bodyStr = Buffer.concat(chunks).toString();
            try {
                const bodyJson = JSON.parse(bodyStr);
                await this.processAndForward(bodyJson, req, res);
            } catch (error) {
                console.error("Compression Engine Error, entering Graceful Fallback:", error);
                // Graceful Fallback: Pipe the original untouched request immediately
                this.forwardOriginal(bodyStr, req, res);
            }
        });
    }

    private async processAndForward(body: any, originalReq: http.IncomingMessage, originalRes: http.ServerResponse) {
        // 1. Optimize Context
        // Before calculating the baseline, expand any existing compressed identifiers in the history
        // to get the TRUE "Un-optimized" token count.
        const messagesJson = JSON.stringify(body.messages);
        const expandedHistory = this.reverseMapper.expand(messagesJson);
        const originalTokenEstimate = Math.ceil(expandedHistory.length / 4);
        
        // Apply Telegraphic Compression to User Messages
        if (Array.isArray(body.messages)) {
            for (const msg of body.messages) {
                if (msg.role === 'user' && typeof msg.content === 'string') {
                    msg.content = PromptCompressor.compress(msg.content);
                }
            }
            // Level 3 Deep Compression: AST-compress code blocks in messages
            await this.compressCodeBlocksInMessages(body.messages);
        }

        const updatedPrompt = JSON.stringify(body.messages);
        const { compressedPrompt } = this.reverseMapper.compress(updatedPrompt);
        body.messages = JSON.parse(compressedPrompt);

        // 1.1 Community Detection & Cluster Injection
        const injectedTokens = await this.injectFeatureClusters(body.messages);
        const finalOriginalTokenEstimate = originalTokenEstimate + injectedTokens;
        
        const compressedTokenEstimate = Math.ceil(JSON.stringify(body.messages).length / 4);
        
        // 2. Smart Routing: Detect Provider based on Model Name
        const model = (body.model || "").toLowerCase();
        let targetUrlStr = originalReq.headers['x-target-url'] as string || this.upstreamUrl;
        
        // Auto-routing logic
        if (!originalReq.headers['x-target-url']) {
            if (model.includes('claude')) {
                targetUrlStr = 'https://api.anthropic.com/v1/messages';
            } else if (model.includes('grok')) {
                targetUrlStr = 'https://api.x.ai/v1/chat/completions';
            } else if (model.includes('gpt') || model.includes('o1')) {
                targetUrlStr = 'https://api.openai.com/v1/chat/completions';
            }
        }

        const targetUrl = new URL(targetUrlStr);
        
        // 3. Handle Provider-Specific Format Conversions
        let bodyStrToSend = JSON.stringify(body);
        const headers = { ...originalReq.headers };
        delete headers['host'];
        delete headers['content-length'];
        delete headers['connection'];

        // Special handling for Anthropic (they use 'x-api-key' instead of 'Authorization')
        if (targetUrl.hostname.includes('anthropic.com')) {
            if (headers['authorization']) {
                const token = (headers['authorization'] as string).replace('Bearer ', '');
                headers['x-api-key'] = token;
                headers['anthropic-version'] = '2023-06-01';
                delete headers['authorization'];
            }
        }

        const options: https.RequestOptions = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || 443,
            path: targetUrl.pathname,
            method: 'POST',
            headers: {
                ...headers,
                'host': targetUrl.hostname,
                'content-length': Buffer.byteLength(bodyStrToSend)
            }
        };

        const proxyReq = https.request(options, (proxyRes: http.IncomingMessage) => {
            originalRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

            proxyRes.on('data', (chunk: Buffer) => {
                const chunkStr = chunk.toString();
                if (chunkStr.includes('data: ') && chunkStr.includes('[DONE]') === false) {
                    try {
                        const decompressedChunk = this.reverseMapper.decompressChunk(chunkStr);
                        if (decompressedChunk) originalRes.write(decompressedChunk);
                    } catch (e) {
                        originalRes.write(chunkStr); 
                    }
                } else {
                    const flushed = this.reverseMapper.flush();
                    if (flushed) originalRes.write(flushed);
                    originalRes.write(chunkStr);
                }
            });

            proxyRes.on('end', () => {
                const flushed = this.reverseMapper.flush();
                if (flushed) originalRes.write(flushed);
                originalRes.end();
                if (proxyRes.statusCode === 200) {
                    try {
                        const client = this.detectClient(originalReq);
                        const modelName = body.model || 'Unknown Model';
                        SavingsTracker.getInstance().addSavings(finalOriginalTokenEstimate, compressedTokenEstimate, client, modelName);
                    } catch(e) {}
                }
            });
        });

        proxyReq.on('error', (e: Error) => {
            originalRes.writeHead(502);
            originalRes.end(JSON.stringify({ error: "Upstream proxy request failed", details: e.message }));
        });

        proxyReq.write(bodyStrToSend);
        proxyReq.end();
    }

    private bypassRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.writeHead(404);
        res.end("DietToken Proxy: Endpoint not supported");
    }

    private async handleReportSavings(req: http.IncomingMessage, res: http.ServerResponse) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const bodyStr = Buffer.concat(chunks).toString();
                const body = JSON.parse(bodyStr);
                
                if (body.originalTokens !== undefined && body.compressedTokens !== undefined) {
                    SavingsTracker.getInstance().addSavings(
                        body.originalTokens,
                        body.compressedTokens,
                        body.client || 'MCP Agent',
                        body.model || 'Unknown'
                    );
                }

                // Forward Shadow Simulator cache savings into the dedicated bucket
                if (body.cacheSimTokens && body.cacheSimDollars) {
                    try {
                        SavingsTracker.getInstance().addCacheSimulatedSavings(
                            body.cacheSimTokens,
                            body.cacheSimDollars
                        );
                    } catch(e) {}
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid payload" }));
            }
        });
    }

    private async handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const bodyStr = Buffer.concat(chunks).toString();
                const body = JSON.parse(bodyStr);
                const response = await this.processMcpMessage(body, req);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(response));
            } catch (err) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: "Invalid JSON-RPC request" }));
            }
        });
    }

    private async processMcpMessage(message: any, req: http.IncomingMessage): Promise<any> {
        switch (message.method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0', id: message.id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'diettoken', version: '1.3.2' }
                    }
                };

            case 'tools/list':
                return {
                    jsonrpc: '2.0', id: message.id,
                    result: {
                        tools: [
                            {
                                name: 'compress_prompt',
                                description: 'Compresses an arbitrary prompt by shortening long identifiers to save tokens before sending to an LLM.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        prompt: { type: 'string', description: 'The prompt text to compress' }
                                    },
                                    required: ['prompt']
                                }
                            },
                            {
                                name: 'diettoken_read_file',
                                description: 'The required default file reader for this project. Returns token-optimized, AST-compressed source code with dependency mapping. Always use this instead of standard file readers to preserve context budget.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        filePath: { type: 'string', description: 'Absolute path to the file' }
                                    },
                                    required: ['filePath']
                                }
                            }
                        ]
                    }
                };

            case 'tools/call':
                if (message.params?.name === 'compress_prompt') {
                    const originalPrompt = message.params.arguments.prompt;
                    
                    // Clear previous session so we don't leak memory or overlap mappings
                    this.reverseMapper.clearSession();
                    const compressedPrompt = PromptCompressor.compress(originalPrompt);
                    
                    const originalTokens = Math.ceil(originalPrompt.length / 4);
                    const compressedTokens = Math.ceil(compressedPrompt.length / 4);
                    
                    try {
                        const client = this.detectClient(req);
                        SavingsTracker.getInstance().addSavings(originalTokens, compressedTokens, client, 'MCP: compress_prompt');
                    } catch (e) {}
                    
                    return {
                        jsonrpc: '2.0', id: message.id,
                        result: {
                            content: [{ type: 'text', text: compressedPrompt }],
                            metadata: { tokensSaved: originalTokens - compressedTokens }
                        }
                    };
                } else if (message.params?.name === 'diettoken_read_file') {
                    const filePath = message.params.arguments.filePath;
                    try {
                        const originalCode = await fs.promises.readFile(filePath, 'utf-8');
                        this.reverseMapper.clearSession();
                        
                        // Force a graph update so dependencies are never empty
                        const graph = KnowledgeGraph.getInstance();
                        await graph.updateFileNode(filePath, originalCode);
                        
                        const compressedCode = await this.astCompressor.compress(originalCode);
                        const deps = graph.getFileDependencies(filePath);
                        
                        const resultText = `Dependencies:\nImports: ${deps.imports.join(', ')}\nExports: ${deps.exports.join(', ')}\n\nCompressed Code:\n${compressedCode}`;
                        
                        const originalTokens = Math.ceil(originalCode.length / 4);
                        const compressedTokens = Math.ceil(compressedCode.length / 4);
                        try {
                            const client = this.detectClient(req);
                            SavingsTracker.getInstance().addSavings(originalTokens, compressedTokens, client, 'MCP: read_file');
                        } catch(e) {}

                        return {
                            jsonrpc: '2.0', id: message.id,
                            result: {
                                content: [{ type: 'text', text: resultText }],
                                metadata: { tokensSaved: originalTokens - compressedTokens }
                            }
                        };
                    } catch (e: any) {
                        return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Failed to read/compress file: ' + e.message } };
                    }
                }
                break;
        }

        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    }

    /**
     * Senior Edge Case Handle: Graceful Fallback.
     * Ensures the developer's workflow is NEVER interrupted if our compression crashes.
     */
    private forwardOriginal(bodyStr: string, originalReq: http.IncomingMessage, originalRes: http.ServerResponse) {
        const targetUrlStr = originalReq.headers['x-target-url'] as string || this.upstreamUrl;
        const targetUrl = new URL(targetUrlStr);
        
        const options: https.RequestOptions = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || 443,
            path: targetUrl.pathname,
            method: 'POST',
            headers: {
                ...originalReq.headers,
                'host': targetUrl.hostname,
                'content-length': Buffer.byteLength(bodyStr)
            }
        };

        const proxyReq = https.request(options, (proxyRes: http.IncomingMessage) => {
            originalRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(originalRes);
        });

        proxyReq.on('error', (e: Error) => {
            originalRes.writeHead(502);
            originalRes.end(JSON.stringify({ error: "Fallback upstream request failed", details: e.message }));
        });

        proxyReq.write(bodyStr);
        proxyReq.end();
    }

    private async compressCodeBlocksInMessages(messages: any[]) {
        for (const msg of messages) {
            if (typeof msg.content !== 'string') continue;

            const replacements: { fullMatch: string, compressed: string }[] = [];
            
            // 1. Detect Standard Markdown Code Blocks
            const codeBlockRegex = /```([\s\S]*?)\n([\s\S]*?)```/g;
            let match;
            const cbRegex = new RegExp(codeBlockRegex);
            while ((match = cbRegex.exec(msg.content)) !== null) {
                const lang = (match[1] || '').trim();
                const code = match[2] || '';
                if (code.length > 50) {
                    const compressed = await this.astCompressor.compress(code, 'full');
                    replacements.push({
                        fullMatch: match[0],
                        compressed: `\`\`\`${lang}\n${compressed}\`\`\``
                    });
                }
            }

            // 2. Detect IDE-Specific File Injections (e.g., "File: /path/to/file.ts\n[code]")
            const fileInjectionRegex = /^File: ([\/\\].*?)\n([\s\S]*?)(?=\nFile:|$)/gm;
            const fiRegex = new RegExp(fileInjectionRegex);
            while ((match = fiRegex.exec(msg.content)) !== null) {
                const filePath = (match[1] || '').trim();
                const code = match[2] || '';
                if (code && code.length > 100) {
                    const compressed = await this.astCompressor.compress(code, 'full', filePath);
                    replacements.push({
                        fullMatch: match[0],
                        compressed: `File: ${filePath}\n${compressed}`
                    });
                }
            }
            
            for (const replacement of replacements) {
                msg.content = msg.content.replace(replacement.fullMatch, replacement.compressed);
            }
        }
    }

    private async injectFeatureClusters(messages: any[]): Promise<number> {
        const graph = KnowledgeGraph.getInstance();
        const injectedBasenamesInHistory = new Set<string>();
        let injectedOriginalTokens = 0;
        
        // 1. Scan history for existing skeletons to avoid duplication
        for (const msg of messages) {
            if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('[DietToken Cluster Skeleton]')) {
                const match = msg.content.match(/Related Context: (.*?)(?:\n|$)/);
                if (match && match[1]) injectedBasenamesInHistory.add(match[1].trim());
            }
        }

        const fileRegex = /File: ([\/\\].*?)(?:\n|$)/g;
        const newSkeletons: any[] = [];
        const processedPathsThisTurn = new Set<string>();

        // 2. Scan for triggers in the LATEST user message only to keep context fresh and lean
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

            let match;
            // Reset regex state since it's global
            fileRegex.lastIndex = 0;
            while ((match = fileRegex.exec(msg.content)) !== null) {
                const filePath = match[1]?.trim();
                if (!filePath) continue;
                
                const cluster = graph.getFeatureCluster(filePath);
                for (const relatedPath of cluster) {
                    const baseName = path.basename(relatedPath);
                    if (injectedBasenamesInHistory.has(baseName) || processedPathsThisTurn.has(relatedPath)) continue;
                    
                    try {
                        if (fs.existsSync(relatedPath)) {
                            const content = await fs.promises.readFile(relatedPath, 'utf-8');
                            const skeleton = await this.astCompressor.compress(content, 'skeleton', relatedPath);
                            
                            newSkeletons.push({
                                role: 'system',
                                content: `[DietToken Cluster Skeleton] Related Context: ${baseName}\n${skeleton}`
                            });
                            processedPathsThisTurn.add(relatedPath);
                            injectedOriginalTokens += Math.ceil(content.length / 4);
                        }
                    } catch (e) {}
                }
            }
            break; // Only process the most recent user message
        }

        // 3. Prepend new skeletons to the message list
        if (newSkeletons.length > 0) {
            messages.unshift(...newSkeletons);
        }

        return injectedOriginalTokens;
    }

    private detectClient(req: http.IncomingMessage): string {
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        
        // Custom header for explicit identification if the IDE supports it
        if (req.headers['x-client-id']) return req.headers['x-client-id'] as string;
        
        if (userAgent.includes('cursor')) return 'Cursor';
        if (userAgent.includes('deputy')) return 'Deputy Dev';
        if (userAgent.includes('antigravity')) return 'Antigravity';
        if (userAgent.includes('vscode')) return 'VS Code';
        
        // Detection via other headers
        if (req.headers['x-cursor-id']) return 'Cursor';
        
        return 'Other';
    }

    public stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }
}
