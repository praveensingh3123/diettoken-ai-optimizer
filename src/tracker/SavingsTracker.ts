import * as vscode from 'vscode';

export class SavingsTracker {
    private static instance: SavingsTracker;
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;
    private totalTokensSaved: number = 0;
    private totalOriginalTokens: number = 0;
    private lastReportedTokens: number = 0;
    
    // Model-specific pricing (Price per 1M Input Tokens in USD)
    private readonly PRICING_REGISTRY: Record<string, number> = {
        'claude-3-5-sonnet': 3.00,
        'claude-3-sonnet': 3.00,
        'claude-3-opus': 15.00,
        'claude-3-haiku': 0.25,
        'gpt-4o': 5.00,
        'gpt-4o-mini': 0.15,
        'gpt-4-turbo': 10.00,
        'gpt-3.5-turbo': 0.50,
        'gemini-1.5-pro': 3.50,
        'gemini-1.5-flash': 0.35,
        'deepseek-v3': 0.14,
        'deepseek-chat': 0.14,
        'unknown': 3.00 // Default fallback
    };

    private totalDollarsSaved: number = 0;
    private totalCacheSimulatedTokensSaved: number = 0;
    private totalCacheSimulatedDollarsSaved: number = 0;

    // Event emitter to notify UI components
    private _onDidUpdateSavings = new vscode.EventEmitter<{ saved: number, original: number }>();
    public readonly onDidUpdateSavings = this._onDidUpdateSavings.event;

    private savingsByClient: Record<string, number> = {};

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        // Robust Migration: Check all possible legacy keys to prevent "intermittent" 0-token resets
        const legacyKeys = ['dietToken.savings', 'savings', 'diettoken_tokens_saved'];
        let loadedSavings = 0;
        
        for (const key of legacyKeys) {
            const val = this.context.globalState.get<number>(key, 0);
            if (val > loadedSavings) {
                loadedSavings = val;
            }
        }
        
        const currentState = this.context.globalState.get<number>('diettoken_tokens_saved', 0);
        this.totalTokensSaved = Math.max(loadedSavings, currentState);
        this.totalOriginalTokens = this.context.globalState.get<number>('diettoken_original_tokens', this.totalTokensSaved * 2);
        
        // Load categorized savings
        this.savingsByClient = this.context.globalState.get<Record<string, number>>('diettoken_savings_by_client', {});
        this.totalDollarsSaved = this.context.globalState.get<number>('diettoken_total_dollars_saved', 0);
        this.totalCacheSimulatedTokensSaved = this.context.globalState.get<number>('diettoken_cache_tokens_saved', 0);
        this.totalCacheSimulatedDollarsSaved = this.context.globalState.get<number>('diettoken_cache_dollars_saved', 0);

        // Backfill: If we have tokens but no dollar amount, estimate it
        if (this.totalDollarsSaved === 0 && this.totalTokensSaved > 0) {
            this.totalDollarsSaved = (this.totalTokensSaved / 1_000_000) * 3.00; // Default $3/1M rate
            this.context.globalState.update('diettoken_total_dollars_saved', this.totalDollarsSaved);
        }

        // Standardize on the newest keys
        this.context.globalState.update('diettoken_tokens_saved', this.totalTokensSaved);
        this.context.globalState.update('diettoken_original_tokens', this.totalOriginalTokens);
        this.context.globalState.update('diettoken_savings_by_client', this.savingsByClient);
        this.context.globalState.update('diettoken_total_dollars_saved', this.totalDollarsSaved);
        
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'dietToken.showStats';
        this.updateStatusBar();
        this.statusBarItem.show();
    }

    public static initialize(context: vscode.ExtensionContext): SavingsTracker {
        if (!SavingsTracker.instance) {
            SavingsTracker.instance = new SavingsTracker(context);
        }
        return SavingsTracker.instance;
    }

    public static getInstance(): SavingsTracker {
        if (!SavingsTracker.instance) {
            throw new Error("SavingsTracker not initialized");
        }
        return SavingsTracker.instance;
    }

    public addSavings(originalTokens: number, compressedTokens: number, client: string = 'VS Code', model: string = 'Unknown') {
        const saved = Math.max(0, originalTokens - compressedTokens);
        this.totalTokensSaved += saved;
        this.totalOriginalTokens += originalTokens;
        
        // Calculate monetary savings based on model
        const modelId = model.toLowerCase();
        let pricePerMillion = this.PRICING_REGISTRY['unknown'];
        
        // Find best match in registry
        for (const [key, price] of Object.entries(this.PRICING_REGISTRY)) {
            if (modelId.includes(key)) {
                pricePerMillion = price;
                break;
            }
        }
        
        const dollarSavings = (saved / 1_000_000) * (pricePerMillion || 3.00);
        this.totalDollarsSaved += dollarSavings;
        
        // Update categorization
        this.savingsByClient[client] = (this.savingsByClient[client] || 0) + saved;

        this.context.globalState.update('diettoken_tokens_saved', this.totalTokensSaved);
        this.context.globalState.update('diettoken_original_tokens', this.totalOriginalTokens);
        this.context.globalState.update('diettoken_savings_by_client', this.savingsByClient);
        this.context.globalState.update('diettoken_total_dollars_saved', this.totalDollarsSaved);
        
        this.updateStatusBar();
        // Notify listeners
        this._onDidUpdateSavings.fire({ saved: this.totalTokensSaved, original: this.totalOriginalTokens });
    }

    private updateStatusBar() {
        const dollarsSaved = this.totalDollarsSaved;
        this.statusBarItem.text = `$(sparkle) $${dollarsSaved.toFixed(3)} Saved`;
        this.statusBarItem.tooltip = `${this.totalTokensSaved.toLocaleString()} tokens saved total via DietToken`;
        
        // Report if we've crossed a 10-token milestone OR if it's the first time
        const milestone = 10;
        if (this.totalTokensSaved > 0 && (Math.floor(this.totalTokensSaved / milestone) > Math.floor(this.lastReportedTokens / milestone))) {
            this.lastReportedTokens = this.totalTokensSaved;
            this.reportTelemetry();
        }
    }

    private async reportTelemetry() {
        try {
            // This is the endpoint where your global data will be collected
            const TELEMETRY_URL = 'https://diettoken-telemetry.vercel.app/api/report';
            
            // We use the built-in VS Code machineId for unique user counts (anonymous)
            const machineId = vscode.env.machineId;

            // Using globalThis.fetch to avoid node-fetch dependencies in the bundle
            await fetch(TELEMETRY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tokens: this.totalTokensSaved,
                    original: this.totalOriginalTokens,
                    dollars: this.totalDollarsSaved,
                    machineId: machineId,
                    version: '2.4.2',
                    model_engine: 'diettoken-v2-premium',
                    timestamp: new Date().toISOString(),
                    savingsByClient: this.savingsByClient,
                    cache_sim_tokens: this.totalCacheSimulatedTokensSaved,
                    cache_sim_dollars: this.totalCacheSimulatedDollarsSaved
                })
            });
            
            console.log(`[Telemetry] Impact reported globally: ${this.totalTokensSaved} tokens.`);
        } catch (e) {
            // Silently fail to ensure the user's coding session is never interrupted
        }
    }

    /**
     * Records estimated savings from provider-level cache hits (Shadow Simulator).
     * Kept in a separate bucket to maintain honest, auditable metrics.
     */
    public addCacheSimulatedSavings(estimatedTokensSaved: number, estimatedDollarsSaved: number) {
        this.totalCacheSimulatedTokensSaved += estimatedTokensSaved;
        this.totalCacheSimulatedDollarsSaved += estimatedDollarsSaved;
        this.context.globalState.update('diettoken_cache_tokens_saved', this.totalCacheSimulatedTokensSaved);
        this.context.globalState.update('diettoken_cache_dollars_saved', this.totalCacheSimulatedDollarsSaved);
        // Re-fire the savings event so the UI refreshes
        this._onDidUpdateSavings.fire({ saved: this.totalTokensSaved, original: this.totalOriginalTokens });
    }

    public getCacheSimulatedTokensSaved() {
        return this.totalCacheSimulatedTokensSaved;
    }

    public getCacheSimulatedDollarsSaved() {
        return this.totalCacheSimulatedDollarsSaved;
    }

    public getTotalSaved() {
        return this.totalTokensSaved;
    }

    public getDollarsSaved() {
        return this.totalDollarsSaved;
    }

    public getSavingsByClient() {
        return this.savingsByClient;
    }


    public getCompressionRatio() {
        if (this.totalOriginalTokens === 0) return 0;
        return (this.totalTokensSaved / this.totalOriginalTokens) * 100;
    }

    public dispose() {
        this.statusBarItem.dispose();
        this._onDidUpdateSavings.dispose();
    }
}
