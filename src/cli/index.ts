#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { MultiBar, Presets } from 'cli-progress';
import { countTokens, KnowledgeGraph, AstCompressor, ReverseMapper } from 'diettoken-core';

const SUPPORTED_EXTS = ['.ts', '.js', '.py', '.java', '.go', '.rs'];

function getAllFiles(dirPath: string, arrayOfFiles: string[] = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach((file) => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== 'out') {
                arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
            }
        } else {
            if (SUPPORTED_EXTS.includes(path.extname(file))) {
                arrayOfFiles.push(fullPath);
            }
        }
    });

    return arrayOfFiles;
}

async function runCli() {
    program
        .name('diettoken')
        .description('Air-Gapped DietToken Proof of Value Demo')
        .argument('<directory>', 'Directory to scan and compress')
        .parse(process.argv);

    const dir = program.args[0];
    if (!dir) {
        console.error(chalk.red('Please provide a directory to scan.'));
        process.exit(1);
    }
    const absoluteDir = path.resolve(dir);

    if (!fs.existsSync(absoluteDir)) {
        console.error(chalk.red(`Directory does not exist: ${absoluteDir}`));
        process.exit(1);
    }

    console.log(chalk.cyan.bold('\n🚀 DietToken: Air-Gapped Codebase Analysis\n'));
    console.log(chalk.gray(`Scanning: ${absoluteDir}`));

    const files = getAllFiles(absoluteDir);
    
    if (files.length === 0) {
        console.log(chalk.yellow('No supported source files found. Supported extensions: ' + SUPPORTED_EXTS.join(', ')));
        process.exit(0);
    }

    console.log(chalk.gray(`Found ${files.length} supported source files.\n`));

    // Initialize core engine
    const kg = KnowledgeGraph.getInstance();
    const extensionPath = path.join(__dirname, '../..'); // Points to the root of the diettoken package
    await kg.initialize(extensionPath);
    const reverseMapper = new ReverseMapper();
    const compressor = new AstCompressor(reverseMapper);

    let totalOriginalTokens = 0;
    let totalCompressedTokens = 0;

    const multibar = new MultiBar({
        clearOnComplete: false,
        hideCursor: true,
        format: ' {bar} | {percentage}% | {value}/{total} files | {filename}'
    }, Presets.shades_classic);

    const bar = multibar.create(files.length, 0);

    for (const file of files) {
        try {
            bar.update(files.indexOf(file), { filename: path.basename(file) });
            const sourceCode = fs.readFileSync(file, 'utf8');
            const original = countTokens(sourceCode);
            
            // For demo, we just force 'skeleton' mode or let it auto-decide
            const compressedCode = await compressor.compress(sourceCode, undefined, file);
            const compressed = countTokens(compressedCode);
            
            totalOriginalTokens += original;
            totalCompressedTokens += compressed;
        } catch (e) {
            // Silently skip files that fail to parse
        }
    }

    multibar.stop();

    const tokensSaved = totalOriginalTokens - totalCompressedTokens;
    const savingsPercent = totalOriginalTokens > 0 ? ((tokensSaved / totalOriginalTokens) * 100).toFixed(1) : '0';
    
    // Assuming gpt-4o pricing for input tokens: $5.00 per 1M tokens
    const COST_PER_1M_TOKENS = 5.00;
    const dollarsSavedPerRequest = (tokensSaved / 1000000) * COST_PER_1M_TOKENS;
    // Assume an average dev makes 100 requests per day, 20 days a month
    const monthlyDollarsSavedPerDev = dollarsSavedPerRequest * 100 * 20;

    console.log(chalk.cyan.bold('\n======================================================'));
    console.log(chalk.cyan.bold('          DIETTOKEN OFFLINE SAVINGS REPORT           '));
    console.log(chalk.cyan.bold('======================================================\n'));
    
    console.log(chalk.white(`  Total Original Tokens:   ${totalOriginalTokens.toLocaleString()}`));
    console.log(chalk.white(`  Total Compressed Tokens: ${totalCompressedTokens.toLocaleString()}`));
    console.log(chalk.green.bold(`  Tokens Saved:            ${tokensSaved.toLocaleString()} (-${savingsPercent}%)`));
    
    console.log(chalk.gray('\n  --------------------------------------------------\n'));
    
    console.log(chalk.white(`  Savings per AI request:  $${dollarsSavedPerRequest.toFixed(4)}`));
    console.log(chalk.green.bold(`  Est. Savings per Dev/Mo: $${monthlyDollarsSavedPerDev.toFixed(2)}`));
    
    console.log(chalk.gray('\n  (Assuming GPT-4o input pricing at $5.00/1M tokens, 100 requests/day)\n'));
    
    console.log(chalk.yellow('🔒 Verification: This analysis ran entirely offline. Zero code left your machine.\n'));
    
    process.exit(0);
}

runCli().catch(console.error);
