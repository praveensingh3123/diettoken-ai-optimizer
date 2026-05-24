declare module 'diettoken-core' {
    export class KnowledgeGraph {
        static getInstance(): KnowledgeGraph;
        initialize(workspacePath: string): Promise<void>;
        updateFileNode(filePath: string, sourceCode: string): Promise<void>;
        getFunctionSlice(filePath: string, functionName: string, sourceCode: string): string;
        getFileDependencies(filePath: string): any;
        getFeatureCluster(nodeId: string): any;
    }

    export class ReverseMapper {
        expand(text: string): string;
        compress(text: string): { compressedPrompt: string, dictionary: Record<string, string> };
        decompressChunk(chunk: string): string;
        flush(): string;
        clearSession(): void;
    }

    export class AstCompressor {
        constructor(reverseMapper: ReverseMapper);
        compress(sourceCode: string, mode?: 'full' | 'skeleton', filePath?: string): Promise<string>;
    }

    export class PromptCompressor {
        static compress(text: string): string;
    }

    export class CacheSimulator {
        static getInstance(): CacheSimulator;
        hashPayload(text: string): string;
        checkAndRecord(hash: string, model: string): boolean;
        estimateSavings(compressedTokens: number, model: string): { estimatedTokensSaved: number, estimatedDollarsSaved: number };
    }

    export function countTokens(text: string): number;
}
