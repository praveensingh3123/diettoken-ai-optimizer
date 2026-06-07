import * as vscode from 'vscode';
import { SavingsTracker } from '../tracker/SavingsTracker';

export class DashboardProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'dietToken.dashboard';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        
        // Listen for messages from the webview (e.g., "ready")
        webviewView.webview.onDidReceiveMessage(message => {
            if (message.type === 'ready') {
                this._updateWebview();
            } else if (message.type === 'setupProject') {
                vscode.commands.executeCommand('dietToken.setupProject');
            }
        });

        // Listen for updates from the tracker
        const tracker = SavingsTracker.getInstance();
        const updateSubscription = tracker.onDidUpdateSavings(() => {
            this._updateWebview();
        });

        webviewView.onDidDispose(() => {
            updateSubscription.dispose();
        });
    }

    private _updateWebview() {
        if (this._view) {
            const tracker = SavingsTracker.getInstance();
            this._view.webview.postMessage({
                type: 'update',
                tokens: tracker.getTotalSaved(),
                dollars: tracker.getDollarsSaved()
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DietToken Dashboard</title>
    <style>
        :root {
            --primary: #00ff88;
            --secondary: #00d4ff;
            --cache: #f59e0b;
            --bg: #0f111a;
            --card-bg: rgba(255, 255, 255, 0.03);
            --border: rgba(255, 255, 255, 0.1);
        }
        body {
            font-family: 'Outfit', 'Inter', -apple-system, sans-serif;
            background-color: var(--bg);
            color: #ffffff;
            margin: 0;
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 24px;
            overflow-x: hidden;
            letter-spacing: -0.01em;
        }
        .hero {
            background: linear-gradient(135deg, rgba(0, 255, 136, 0.1) 0%, rgba(0, 212, 255, 0.1) 100%);
            border: 1px solid var(--primary);
            border-radius: 20px;
            padding: 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
            box-shadow: 0 0 40px rgba(0, 255, 136, 0.1);
        }
        .hero::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, rgba(0, 255, 136, 0.05) 0%, transparent 70%);
            animation: rotate 10s linear infinite;
        }
        @keyframes rotate {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .hero-label {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            color: var(--primary);
            font-weight: 700;
            margin-bottom: 12px;
        }
        .hero-value {
            font-size: 3.5rem;
            font-weight: 900;
            margin: 0;
            background: linear-gradient(to right, #ffffff, var(--primary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .stat-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 16px;
        }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 20px;
            backdrop-filter: blur(20px);
            transition: all 0.3s ease;
        }
        .card:hover {
            border-color: rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.05);
            transform: translateY(-2px);
        }
        .label {
            font-size: 0.7rem;
            color: rgba(255, 255, 255, 0.5);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 6px;
        }
        .value {
            font-size: 1.5rem;
            font-weight: 700;
        }
        .chart-container {
            margin-top: 8px;
        }
        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
        }
        .model-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .model-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 10px;
            font-size: 0.9rem;
        }
        .model-name {
            color: rgba(255, 255, 255, 0.8);
            font-weight: 500;
        }
        .model-value {
            color: var(--secondary);
            font-weight: 700;
        }
        .footer {
            font-size: 0.65rem;
            color: rgba(255, 255, 255, 0.2);
            text-align: center;
            padding-top: 8px;
        }
        .section-title {
            font-size: 0.65rem;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            font-weight: 700;
            margin-bottom: 8px;
            padding: 0 4px;
        }
        .section-title.structural { color: var(--primary); }
        .section-title.cache { color: var(--cache); }
        .hero {
            border-radius: 16px;
            padding: 22px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        .hero.structural {
            background: linear-gradient(135deg, rgba(0, 255, 136, 0.08) 0%, rgba(0, 212, 255, 0.08) 100%);
            border: 1px solid rgba(0, 255, 136, 0.4);
            box-shadow: 0 0 30px rgba(0, 255, 136, 0.08);
        }
        .hero.cache-sim {
            background: linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(239, 68, 68, 0.05) 100%);
            border: 1px solid rgba(245, 158, 11, 0.35);
            box-shadow: 0 0 30px rgba(245, 158, 11, 0.08);
        }
        .hero-label {
            font-size: 0.7rem;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            font-weight: 700;
            margin-bottom: 10px;
        }
        .structural .hero-label { color: var(--primary); }
        .cache-sim .hero-label { color: var(--cache); }
        .hero-value {
            font-size: 2.8rem;
            font-weight: 900;
            margin: 0;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .structural .hero-value {
            background: linear-gradient(to right, #ffffff, var(--primary));
            -webkit-background-clip: text;
        }
        .cache-sim .hero-value {
            background: linear-gradient(to right, #ffffff, var(--cache));
            -webkit-background-clip: text;
        }
        .hero-sub { font-size: 0.75rem; margin-top: 8px; opacity: 0.6; }
        .divider { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 4px 0; }
        .stat-row { display: grid; grid-template-columns: 1fr; gap: 10px; }
        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 14px;
            padding: 16px;
            transition: all 0.3s ease;
        }
        .card:hover {
            border-color: rgba(255,255,255,0.18);
            background: rgba(255,255,255,0.05);
            transform: translateY(-2px);
        }
        .label {
            font-size: 0.65rem;
            color: rgba(255,255,255,0.45);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 6px;
        }
        .value { font-size: 1.3rem; font-weight: 700; }
        .value.green { color: var(--primary); }
        .value.amber { color: var(--cache); }
        .disclaimer {
            font-size: 0.62rem;
            color: rgba(255,255,255,0.35);
            text-align: center;
            padding: 8px;
            border-radius: 8px;
            background: rgba(0, 255, 136, 0.03);
            border: 1px solid rgba(0, 255, 136, 0.1);
            margin-top: 16px;
            line-height: 1.4;
        }
        .setup-btn {
            display: block;
            width: 100%;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: #0f111a;
            border: none;
            border-radius: 12px;
            padding: 16px 20px;
            font-size: 0.95rem;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 4px 15px rgba(0, 255, 136, 0.2);
            margin-bottom: 16px;
        }
        .setup-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0, 255, 136, 0.3);
        }
        .setup-btn:active {
            transform: translateY(1px);
        }
    </style>
</head>
<body>

    <div class="section-title structural">⚡ Structural Efficiency</div>
    <div class="hero structural">
        <div class="hero-label">Tokens Pruned by DietToken</div>
        <div class="hero-value" id="tokens-saved">0</div>
    </div>
    
    <button class="setup-btn" id="setup-btn">🚀 Initialize Context Layer</button>

    <div class="stat-row">
        <div class="card">
            <div class="label">Direct Savings</div>
            <div class="value green" id="dollars-saved">$0.000</div>
        </div>
    </div>

    <hr class="divider">

    <div class="disclaimer">
        <strong>Your Code Never Leaves Your Machine</strong><br>
        DietToken runs entirely locally. No cloud processing. No third-party servers. No data collection.
    </div>

    <div class="footer">DietToken AI Optimizer &bull; v2.6.1</div>

    <script>
        const tokensEl = document.getElementById('tokens-saved');
        const dollarsEl = document.getElementById('dollars-saved');
        const vscode = acquireVsCodeApi();

        document.getElementById('setup-btn').addEventListener('click', () => {
            vscode.postMessage({ type: 'setupProject' });
            document.getElementById('setup-btn').innerText = 'Initializing...';
            setTimeout(() => {
                document.getElementById('setup-btn').innerText = '🚀 Initialize Context Layer';
            }, 3000);
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'update') {
                tokensEl.innerText = (msg.tokens || 0).toLocaleString();
                dollarsEl.innerText = '$' + (msg.dollars || 0).toFixed(3);
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
