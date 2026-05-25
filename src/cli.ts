import * as fs from 'fs';
import * as path from 'path';
import { KnowledgeGraph, AstCompressor, ReverseMapper, countTokens } from 'diettoken-core';

async function run() {
    const args = process.argv.slice(2);
    const targetFile = args[0] || 'test_boilerplate.py';
    const filePath = path.resolve(process.cwd(), targetFile);

    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${targetFile}`);
        process.exit(1);
    }

    console.log(`Verifying: ${targetFile} ...`);

    const sourceCode = fs.readFileSync(filePath, 'utf-8');
    const originalTokens = countTokens(sourceCode);

    // Pass the root of the optimizer project so worker can find flattened node_modules
    const packageRoot = path.resolve(__dirname, '..');
    
    const graph = KnowledgeGraph.getInstance();
    await graph.initialize(packageRoot);
    await graph.updateFileNode(filePath, sourceCode);

    const compressor = new AstCompressor(new ReverseMapper());
    const compressedCode = await compressor.compress(sourceCode, undefined, filePath);
    const compressedTokens = countTokens(compressedCode);

    // Write the compressed file so the client can manually verify it
    const parsedPath = path.parse(filePath);
    const compressedFilePath = path.join(parsedPath.dir, `${parsedPath.name}.diet${parsedPath.ext}`);
    fs.writeFileSync(compressedFilePath, compressedCode, 'utf-8');

    const tokensSaved = originalTokens - compressedTokens;
    const compressionRatio = originalTokens > 0 ? ((tokensSaved / originalTokens) * 100).toFixed(1) : "0.0";

    console.log(`
──────────────────────────────────────
DietToken Verification Report
──────────────────────────────────────
File:             ${targetFile}
Original tokens:  ${originalTokens.toLocaleString()}  (measured via tiktoken)
Compressed tokens: ${compressedTokens.toLocaleString()}  (measured via tiktoken)
Tokens saved:     ${tokensSaved.toLocaleString()}
Compression ratio: ${compressionRatio}%
──────────────────────────────────────
Measurement method: tiktoken (OpenAI's own tokenizer)
This report runs 100% offline. Nothing was sent anywhere.
You can verify the token counts independently at:
platform.openai.com/tokenizer

👉 An uncompressed artifact was generated for your inspection:
   ${parsedPath.name}.diet${parsedPath.ext}
   (Paste this file into the OpenAI tokenizer to verify the ${compressedTokens} count)
──────────────────────────────────────
`);

    process.exit(0);
}

run().catch(e => {
    console.error("Verification failed:", e.message);
    process.exit(1);
});
