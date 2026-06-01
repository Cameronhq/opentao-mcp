import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';

// OpenTAO MCP — read-only "Start mining" tools for any agent.
// Backed by https://opentao.ai/mining-data.json (the site + this server share
// one source). NO write actions: anything that costs TAO/GPU is returned as
// text for the operator to run and confirm.

interface Env {
  DATA_URL: string;
  OpenTaoMCP: DurableObjectNamespace;
}

// ---- data layer ---------------------------------------------------------
type Miners = { registered: number; slots: number; earning: number; rewardConcentration: number | null };
interface Subnet {
  netuid: number; slug: string; name: string; category: string; categoryLabel: string;
  owner: string; description: string;
  emission: { display: string; taoPerDay: number | null };
  marketCap: string; priceTao: number | null;
  change7d: { display: string; pct: number | null };
  miners: Miners; validators: number;
  playbook: { status: 'verified' | 'stale' | 'missing'; url: string; hasRich: boolean };
  links: { github: string | null; twitter: string | null; site: string | null };
  rich: any | null;
}
interface MiningData {
  source: string; license: string; notice: string; dataFetchedAt: string;
  counts: Record<string, number>; setupGuideUrl: string; subnets: Subnet[];
}

let CACHE: { data: MiningData; at: number } | null = null;

async function loadData(env: Env): Promise<MiningData> {
  const now = Date.now();
  if (CACHE && now - CACHE.at < 300_000) return CACHE.data;
  const res = await fetch(env.DATA_URL, { cf: { cacheTtl: 300, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error(`failed to load mining data: ${res.status}`);
  const data = (await res.json()) as MiningData;
  CACHE = { data, at: now };
  return data;
}

const SAFETY =
  'Read-only data. Registering on a subnet and running a miner cost real TAO and GPU time. ' +
  'Always show the operator the exact command and have them run + confirm it themselves — never auto-execute.';

const json = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] });

// rough VRAM tier from a free-text hardware string
function vramTier(hw: string): { tier: 'cpu' | 'single-gpu' | 'multi-gpu' | 'unknown'; vram: number } {
  const s = hw.toLowerCase();
  if (/\b(cpu|no gpu|cpu-only|cpu only)\b/.test(s)) return { tier: 'cpu', vram: 0 };
  if (/\b(h100|a100|cluster|8x|4x|multi)\b/.test(s)) return { tier: 'multi-gpu', vram: 80 };
  if (/\b(4090|3090|4080|a6000|gpu|24g|24 gb|rtx)\b/.test(s)) return { tier: 'single-gpu', vram: 24 };
  return { tier: 'unknown', vram: 0 };
}

function compact(s: Subnet) {
  return {
    netuid: s.netuid, name: s.name, category: s.categoryLabel,
    emissionTaoPerDay: s.emission.taoPerDay,
    minersRegistered: s.miners.registered, minerSlots: s.miners.slots,
    minersEarning: s.miners.earning, rewardConcentration: s.miners.rewardConcentration,
    change7dPct: s.change7d.pct,
    playbook: s.playbook.status, hasRichPlaybook: s.playbook.hasRich,
    url: `https://opentao.ai/beginner/subnets/${s.slug}`,
    playbookUrl: s.playbook.url,
  };
}

export class OpenTaoMCP extends McpAgent<Env, unknown, {}> {
  server = new McpServer({ name: 'opentao-mining', version: '1.0.0' });

  async init() {
    const env = this.env;

    this.server.registerTool(
      'list_subnets',
      {
        description:
          'List Bittensor subnets with live mining economics (emission, miner counts, reward concentration, 7d price change) and playbook coverage. Filter and sort to scan the field.',
        inputSchema: {
          category: z.string().optional().describe('e.g. llm, vision, audio, data, compute, reason, storage, robotics'),
          status: z.enum(['verified', 'stale', 'missing']).optional().describe('playbook status'),
          hasPlaybook: z.boolean().optional().describe('only subnets with a detailed (rich) playbook'),
          sortBy: z.enum(['emission', 'minersEarning', 'rewardConcentration', 'change7d', 'netuid']).default('emission'),
          order: z.enum(['asc', 'desc']).default('desc'),
          limit: z.number().int().min(1).max(128).default(20),
        },
      },
      async ({ category, status, hasPlaybook, sortBy, order, limit }) => {
        const d = await loadData(env);
        let rows = d.subnets;
        if (category) rows = rows.filter((s) => s.category === category);
        if (status) rows = rows.filter((s) => s.playbook.status === status);
        if (hasPlaybook) rows = rows.filter((s) => s.playbook.hasRich);
        const key = (s: Subnet) =>
          sortBy === 'emission' ? (s.emission.taoPerDay ?? -1)
          : sortBy === 'minersEarning' ? s.miners.earning
          : sortBy === 'rewardConcentration' ? (s.miners.rewardConcentration ?? -1)
          : sortBy === 'change7d' ? (s.change7d.pct ?? -999)
          : s.netuid;
        rows = [...rows].sort((a, b) => (key(a) - key(b)) * (order === 'asc' ? 1 : -1)).slice(0, limit);
        return json({ dataFetchedAt: d.dataFetchedAt, count: rows.length, subnets: rows.map(compact) });
      },
    );

    this.server.registerTool(
      'get_subnet',
      {
        description: 'Full overview of one subnet by netuid: economics, miner/validator counts, hardware summary, links, and whether a detailed playbook exists.',
        inputSchema: { netuid: z.number().int() },
      },
      async ({ netuid }) => {
        const d = await loadData(env);
        const s = d.subnets.find((x) => x.netuid === netuid);
        if (!s) return json({ error: `no subnet with netuid ${netuid}` });
        return json({
          dataFetchedAt: d.dataFetchedAt,
          ...compact(s),
          owner: s.owner, description: s.description,
          marketCap: s.marketCap, priceTao: s.priceTao,
          validators: s.validators, links: s.links,
          hardware: s.rich?.hardware ?? null,
          rentalOk: s.rich?.rentalOk ?? null,
        });
      },
    );

    this.server.registerTool(
      'get_playbook',
      {
        description: 'Step-by-step mining playbook for one subnet: hardware, repo, install + run commands, env vars, validator scoring, profitability. Commands are for the operator to run themselves.',
        inputSchema: { netuid: z.number().int() },
      },
      async ({ netuid }) => {
        const d = await loadData(env);
        const s = d.subnets.find((x) => x.netuid === netuid);
        if (!s) return json({ error: `no subnet with netuid ${netuid}` });
        if (!s.rich) {
          return json({
            netuid, name: s.name, status: s.playbook.status,
            message: 'No detailed playbook yet. Start from the general setup guide, then register on this subnet.',
            setupGuideUrl: d.setupGuideUrl, subnetUrl: `https://opentao.ai/beginner/subnets/${s.slug}`,
            safety: SAFETY,
          });
        }
        return json({
          netuid, name: s.name, verifiedAt: s.rich.verifiedAt,
          whatMinersDo: s.rich.whatMinersDo,
          hardware: s.rich.hardware, hardwareNote: s.rich.hardwareNote,
          rentalOk: s.rich.rentalOk, rentalUsdPerHr: s.rich.rentalUsdPerHr,
          repo: s.rich.repo, setupOverview: s.rich.setupOverview,
          install: s.rich.install, runSteps: s.rich.runSteps, envVars: s.rich.envVars,
          scoring: s.rich.scoring, profitability: s.rich.profitability, knownIssues: s.rich.knownIssues,
          safety: SAFETY,
        });
      },
    );

    this.server.registerTool(
      'get_setup_guide',
      {
        description: 'The one-time general setup every miner does before registering on any subnet: install deps, btcli, create wallet, fund, register.',
        inputSchema: { os: z.enum(['macos', 'linux', 'wsl']).default('linux') },
      },
      async ({ os }) => {
        const d = await loadData(env);
        const install =
          os === 'macos' ? 'brew install python@3.12 git'
          : 'sudo apt update && sudo apt install -y python3.12 python3.12-venv python3-pip git build-essential';
        return json({
          os,
          fullGuideUrl: d.setupGuideUrl,
          steps: [
            { n: 1, title: 'System requirements', detail: 'Python 3.10–3.12, disk ≥ 50GB, RAM ≥ 16GB. Miners are not supported on native Windows — use WSL2/Linux.' },
            { n: 2, title: 'Install dependencies', cmd: install },
            { n: 3, title: 'Install btcli', cmd: 'python3 -m venv ~/.venv-bittensor && source ~/.venv-bittensor/bin/activate && pip install bittensor-cli' },
            { n: 4, title: 'Create wallet', cmd: 'btcli wallet create --wallet.name my-coldkey --wallet.hotkey my-hot1', note: 'Write down the 12-word mnemonic. No recovery without it.' },
            { n: 5, title: 'Fund the coldkey', detail: 'Transfer enough TAO to cover the registration burn (see get_subnet for the subnet you want).' },
            { n: 6, title: 'Register on a subnet', cmd: 'btcli subnet register --netuid <NETUID> --wallet.name my-coldkey --wallet.hotkey my-hot1', note: 'COSTS REAL TAO. Confirm the burn cost before running.' },
            { n: 7, title: 'Run the subnet miner', detail: 'Follow get_playbook(netuid) for the subnet-specific repo + run command.' },
          ],
          safety: SAFETY,
        });
      },
    );

    this.server.registerTool(
      'recommend_subnets',
      {
        description:
          'Recommend subnets to mine given the operator\'s hardware, budget and goal. Ranks by emission, how accessible rewards are (reward concentration), playbook availability, and hardware fit. Advisory only.',
        inputSchema: {
          hardware: z.string().describe('free text, e.g. "RTX 4090 24GB", "2x H100", "CPU only", "8 vCPU 32GB"'),
          goal: z.enum(['max-emission', 'beginner-friendly', 'low-competition']).default('beginner-friendly'),
          budget: z.string().optional().describe('free text, e.g. "under $1/hr rental", "have the GPU already"'),
          count: z.number().int().min(1).max(15).default(5),
        },
      },
      async ({ hardware, goal, count }) => {
        const d = await loadData(env);
        const ht = vramTier(hardware);
        const scored = d.subnets
          .map((s) => {
            const emis = s.emission.taoPerDay ?? 0;
            const conc = s.miners.rewardConcentration ?? 0; // higher = more miners earn = more accessible
            const hasPb = s.playbook.hasRich ? 1 : 0;
            // hardware fit from rich playbook VRAM, if present
            let fit = 0.5;
            const need = s.rich?.hardware?.[0]?.vramGb as number | undefined;
            if (typeof need === 'number' && ht.vram > 0) fit = ht.vram >= need ? 1 : 0.15;
            const emisNorm = Math.min(emis / 300, 1);
            let score: number;
            if (goal === 'max-emission') score = emisNorm * 0.6 + hasPb * 0.2 + fit * 0.2;
            else if (goal === 'low-competition') score = (1 - conc) * 0.5 + emisNorm * 0.2 + hasPb * 0.2 + fit * 0.1;
            else score = hasPb * 0.4 + conc * 0.3 + fit * 0.2 + emisNorm * 0.1; // beginner-friendly
            const why: string[] = [];
            if (hasPb) why.push('has a verified playbook');
            if (conc >= 0.3) why.push(`${Math.round(conc * 100)}% of registered miners earn (accessible)`);
            else if (conc > 0 && conc < 0.1) why.push('winner-take-all — hard to break in');
            if (emis >= 100) why.push(`~${Math.round(emis)} τ/day emission`);
            if (typeof need === 'number') why.push(`needs ~${need}GB VRAM${ht.vram ? (ht.vram >= need ? ' — your hardware fits' : ' — above your hardware') : ''}`);
            return { s, score, why };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, count);
        return json({
          hardwareParsed: ht, goal, dataFetchedAt: d.dataFetchedAt,
          recommendations: scored.map((r) => ({ ...compact(r.s), why: r.why.join('; ') })),
          note: 'Heuristic ranking from live data. ' + SAFETY,
        });
      },
    );

    this.server.registerTool(
      'get_resources',
      {
        description: 'Pointers to mining resources (wallets, GPU rental, tooling) on opentao.ai.',
        inputSchema: { topic: z.enum(['wallets', 'gpus', 'all']).default('all') },
      },
      async ({ topic }) => {
        return json({
          topic,
          url: 'https://opentao.ai/mine/resources',
          note: 'See the resources page for the current wallet and GPU-rental options.',
        });
      },
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({ name: 'opentao-mining MCP', transport: { streamableHttp: '/mcp', sse: '/sse' }, source: 'https://opentao.ai/mining-data.json' }, null, 2),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.pathname.startsWith('/mcp')) {
      return OpenTaoMCP.serve('/mcp', { binding: 'OpenTaoMCP' }).fetch(request, env, ctx);
    }
    if (url.pathname.startsWith('/sse')) {
      return OpenTaoMCP.serveSSE('/sse', { binding: 'OpenTaoMCP' }).fetch(request, env, ctx);
    }
    return new Response('Not found', { status: 404 });
  },
};
