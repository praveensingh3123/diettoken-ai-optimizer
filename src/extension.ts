import * as vscode from 'vscode';
import { ProxyServer } from './proxy/ProxyServer';
import { SavingsTracker } from './tracker/SavingsTracker';
import { DashboardProvider } from './ui/DashboardProvider';
import { KnowledgeGraph } from 'diettoken-core';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

let proxyServer: ProxyServer | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('DietToken is now active!');

    // 1. Initialize Tracker
    const tracker = SavingsTracker.initialize(context);

    // 2. Register Dashboard UI
    const dashboardProvider = new DashboardProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, dashboardProvider)
    );

    // 3. Spin up Proxy Server
    proxyServer = new ProxyServer();
    
    // Load initial upstream URL from settings
    const config = vscode.workspace.getConfiguration('dietToken');
    proxyServer.setUpstreamUrl(config.get<string>('upstreamApiUrl', 'https://api.openai.com/v1/chat/completions'));

    // Listen for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('dietToken.upstreamApiUrl')) {
            const newUrl = vscode.workspace.getConfiguration('dietToken').get<string>('upstreamApiUrl');
            if (newUrl && proxyServer) {
                proxyServer.setUpstreamUrl(newUrl);
            }
        }
    }));

    try {
        const port = await proxyServer.start(8080);
        vscode.window.showInformationMessage(
            `DietToken running on port ${port}. Dashboard ready in Sidebar.`
        );
        
        // Initialize AST Knowledge Graph
        const graph = KnowledgeGraph.getInstance();
        await graph.initialize(context.extensionPath);

        // Setup File Watcher for incremental graph updates
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,jsx,tsx}');
        
        const updateGraph = async (uri: vscode.Uri) => {
            try {
                // Read from disk to avoid opening a visible editor
                const content = await vscode.workspace.fs.readFile(uri);
                graph.updateFileNode(uri.fsPath, content.toString());
            } catch (e) {}
        };
        
        watcher.onDidChange(updateGraph);
        watcher.onDidCreate(updateGraph);
        context.subscriptions.push(watcher);

        // Auto-configure MCP for DeputyDev and Antigravity
        await autoConfigureMcp(port, context);
    } catch (error: any) {
        vscode.window.showErrorMessage(`DietToken failed: ${error.message}`);
    }

    // 4. Register Commands
    const setupProjectCommand = vscode.commands.registerCommand('dietToken.setupProject', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage("DietToken: No workspace folder is currently open.");
            return;
        }
        
        const workspacePath = workspaceFolders[0].uri.fsPath;
        const cliPath = path.join(context.extensionPath, 'node_modules', 'diettoken-core', 'out', 'cli.js');
        
        if (!fs.existsSync(cliPath)) {
            vscode.window.showErrorMessage("DietToken: CLI engine not found inside extension package.");
            return;
        }

        const cp = require('child_process');
        try {
            cp.execSync(`node "${cliPath}" init`, { cwd: workspacePath });
            vscode.window.showInformationMessage("🚀 DietToken Context Layer initialized successfully for this project!");
        } catch (error: any) {
            vscode.window.showErrorMessage(`DietToken Setup Failed: ${error.message}`);
        }
    });

    const showStatsCommand = vscode.commands.registerCommand('dietToken.showStats', () => {
        vscode.window.showInformationMessage(
            `DietToken has saved you ${tracker.getTotalSaved().toLocaleString()} tokens so far!`
        );
    });

    // TEST COMMAND: Simulates a request to show the user it works immediately
    const simulateCommand = vscode.commands.registerCommand('dietToken.simulateRequest', async () => {
        vscode.window.showInformationMessage("Simulating token-heavy request...");
        
        // Mock a request that would benefit from compression
        const tracker = SavingsTracker.getInstance();
        const before = tracker.getTotalSaved();
        
        // We'll just manually call the tracker for simulation purposes to avoid complex HTTP loopback in this demo
        // but it proves the UI updates dynamically.
        setTimeout(() => {
            tracker.addSavings(50000, 12000, 'Simulation', 'gpt-4o'); // Simulate saving 38,000 tokens (~$0.19)
            const after = tracker.getTotalSaved();
            vscode.window.showInformationMessage(`Simulation complete! Saved ${after - before} tokens.`);
        }, 1500);
    });

    context.subscriptions.push(setupProjectCommand, showStatsCommand, simulateCommand);

    // Cleanup
    context.subscriptions.push({
        dispose: () => {
            if (proxyServer) proxyServer.stop();
            tracker.dispose();
        }
    });
}

export function deactivate() {
    if (proxyServer) {
        proxyServer.stop();
    }
}

async function autoConfigureMcp(port: number, context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const firstFolder = workspaceFolders?.[0];
    if (!firstFolder) { return; }

    const mcpConfigPath = path.join(firstFolder.uri.fsPath, '.vscode', 'mcp.json');
    const mcpConfig = {
        mcpServers: {
            diettoken: {
                type: 'sse',
                url: `http://localhost:${port}/mcp`
            }
        }
    };

    try {
        fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
        
        // Read existing if any to avoid overwriting other servers
        let finalConfig: any = mcpConfig;
        if (fs.existsSync(mcpConfigPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
                if (!existing.mcpServers) {
                    existing.mcpServers = {};
                }
                existing.mcpServers.diettoken = mcpConfig.mcpServers.diettoken;
                finalConfig = existing;
            } catch (e) {}
        }

        fs.writeFileSync(mcpConfigPath, JSON.stringify(finalConfig, null, 2));
    } catch (error) {
        console.error("Failed to auto-configure MCP:", error);
    }
}
