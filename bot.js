import "dotenv/config";
import http from "node:http";
import Gun from "gun";
import WS from "ws";
import { createClient } from "@supabase/supabase-js";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback as viemFallback,
  http as viemHttp,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Para, Environment } from "@getpara/server-sdk";
import { createParaViemClient } from "@getpara/viem-v2-integration";

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PARA_API_KEY = env.PARA_API_KEY || env.VITE_PARA_API_KEY;
const OPTIONAL = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_PARA_API_KEY",
  "PARA_API_SECRET",
  "MONAD_RPC_URL",
  "FEE_WALLET_ADDRESS",
  "FEE_WALLET_PRIVATE_KEY",
  "FEE_BPS_MARKET",
  "FEE_BPS_LIMIT",
  "FEE_BPS_COPY",
  "DIROL_API_BASE",
  "GUN_DATA_DIR",
  "PORT",
  "GUN_PORT",
  "GUN_ALLOW_ORIGIN",
  "GUN_MAX_MESSAGE_AGE_DAYS",
];

const missing = [
  !SUPABASE_URL ? "SUPABASE_URL or VITE_SUPABASE_URL" : null,
  !SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null,
  !PARA_API_KEY ? "PARA_API_KEY or VITE_PARA_API_KEY" : null,
].filter(Boolean);
if (missing.length) {
  console.error("[bot] fatal: missing required Railway variables:", missing.join(", "));
  console.error("[bot] set these in Railway > Service > Variables, then redeploy.");
  process.exit(1);
}

console.log("trench.meme bot - Para runtime");
console.log("required env: all set");
for (const key of OPTIONAL) {
  console.log(`${env[key] ? "yes" : "no "} ${key}${env[key] ? "" : " (feature may skip)"}`);
}

const PORT = Number(env.PORT || env.GUN_PORT || 8765);
const HOST = env.GUN_HOST || "0.0.0.0";
const GUN_DATA_DIR = env.GUN_DATA_DIR || "./gun-data";
const GUN_ALLOW_ORIGIN = env.GUN_ALLOW_ORIGIN || "*";
const RPC_URLS = [
  env.MONAD_RPC_URL,
  env.VITE_MONAD_RPC_URL,
  ...(env.MONAD_RPC_FALLBACK_URLS || "").split(","),
  "https://rpc.monad.xyz",
].map((url) => url?.trim()).filter(Boolean);
const UNIQUE_RPC_URLS = [...new Set(RPC_URLS)];
const RPC = UNIQUE_RPC_URLS[0];
const MONAD_TRANSPORT = viemFallback(UNIQUE_RPC_URLS.map((url) => viemHttp(url)), {
  rank: false,
  retryCount: 1,
});
const PARA_API_SECRET = env.PARA_API_SECRET || "";
const FEE_WALLET = env.FEE_WALLET_ADDRESS || "";
const NADFUN_ROUTER = "0x8986C8fD44eb85294A725a7e61AF35E76bA26F91";
const NADFUN_LEGACY_LENS = "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea";
const NADFUN_BASE = env.NADFUN_API_BASE || "https://api.nad.fun";
const NADFUN_KEY = env.NADFUN_API_KEY || "";
const DIROL_BASE = env.DIROL_API_BASE || "https://api.dirol.io/api/v1";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const FIRE_COOLDOWN_MS = 5 * 60_000;

if (!PARA_API_SECRET) {
  console.warn("[bot] PARA_API_SECRET is empty. Para signing uses PARA_API_KEY here, but keep the secret in Railway.");
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WS },
});

const monad = {
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const publicClient = createPublicClient({ chain: monad, transport: MONAD_TRANSPORT });

const NADFUN_ROUTER_ABI = parseAbi([
  "function buyWithNative((address token,uint256 amountOutMin,address to,uint256 deadline)) payable returns (uint256)",
  "function sell((address token,uint256 amountIn,uint256 amountOutMin,address to,uint256 deadline)) returns (uint256)",
  "function sellToNative((address token,uint256 amountIn,uint256 amountOutMin,address to,uint256 deadline)) returns (uint256)",
  "function getAmountOut(address token,uint256 amountIn,bool isBuy) view returns (uint256)",
]);

const NADFUN_LEGACY_LENS_ABI = parseAbi([
  "function getAmountOut(address token,uint256 amountIn,bool isBuy) view returns (address router,uint256 amountOut)",
]);

const NADFUN_LEGACY_ROUTER_ABI = parseAbi([
  "function buy((uint256 amountOutMin,address token,address to,uint256 deadline)) payable returns (uint256)",
  "function sell((uint256 amountIn,uint256 amountOutMin,address token,address to,uint256 deadline)) returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

function log(label, ...args) {
  console.log(`[${label}] ${new Date().toISOString()}`, ...args);
}

function safe(label, fn) {
  return Promise.resolve(fn()).catch((err) => {
    log(label, "error:", err?.shortMessage || err?.message || err);
    if (gun) {
      gun.get("system").get("workers").get(label).put({
        ok: false,
        error: String(err?.shortMessage || err?.message || err),
        updatedAt: new Date().toISOString(),
      });
    }
  });
}

function loop(label, intervalMs, fn) {
  log(label, `scheduled every ${Math.round(intervalMs / 1000)}s`);
  safe(label, async () => {
    await fn();
    heartbeatWorker(label, true);
  });
  setInterval(() => safe(label, async () => {
    await fn();
    heartbeatWorker(label, true);
  }), intervalMs);
}

function heartbeatWorker(label, ok) {
  if (!gun) return;
  gun.get("system").get("workers").get(label).put({
    ok,
    updatedAt: new Date().toISOString(),
  });
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function asBigInt(value, fallback = 0n) {
  if (value === null || value === undefined || value === "") return fallback;
  return BigInt(String(value).split(".")[0]);
}

function decimalToWei(value) {
  const raw = String(value ?? "0").trim();
  if (!raw) return 0n;
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt(`${fraction}000000000000000000`.slice(0, 18) || "0");
}

function percentToBps(value) {
  return BigInt(Math.max(0, Math.round(Number(value ?? 100) * 100)));
}

function cmp(op, left, right) {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (op || ">=") {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "any": return true;
    default: return false;
  }
}

function short(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": GUN_ALLOW_ORIGIN,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.url?.startsWith("/gun")) return;
  if (req.url === "/" || req.url === "/health" || req.url === "/ready") {
    return json(res, 200, {
      ok: true,
      service: "trenchmeme-bot",
      gun: "/gun",
      workers: [
        "copy-trade",
        "limit-order",
        "executor",
        "alerts",
        "pnl",
        "smart-money",
        "bubble-map",
        "feed-ranker",
        "redemption",
      ],
      tokenDiscovery: false,
      uptime: process.uptime(),
    });
  }
  json(res, 404, { ok: false, error: "not_found" });
});

const gun = Gun({ web: server, file: GUN_DATA_DIR, radisk: true, axe: false });
gun.get("system").get("bot").put({
  online: true,
  tokenDiscovery: false,
  updatedAt: new Date().toISOString(),
});

server.listen(PORT, HOST, () => {
  log("gun-relay", `listening on http://${HOST}:${PORT} data=${GUN_DATA_DIR}`);
});

async function paraClientFor(owner) {
  const { data, error } = await sb
    .from("para_wallets")
    .select("session, session_cookie, expires_at, updated_at")
    .eq("owner_address", lower(owner))
    .maybeSingle();
  if (error) throw error;
  const expiresAt = data?.expires_at
    ? +new Date(data.expires_at)
    : data?.updated_at
      ? +new Date(data.updated_at) + 7 * 86_400_000
      : 0;
  if (expiresAt && Date.now() > expiresAt) throw new Error(`Para session expired for ${owner}; sign in again`);
  if (!data?.session) throw new Error(`no zero-popup Para session for ${owner}; sign out and back in`);

  try {
    const decoded = JSON.parse(Buffer.from(data.session, "base64").toString("utf8"));
    const wallets = Object.values(decoded.wallets || {});
    const hasEvmSigner = wallets.some((w) => w?.type === "EVM" && w?.signer);
    if (!hasEvmSigner || !decoded.sessionCookie) throw new Error("missing signer");
  } catch {
    throw new Error(`saved Para session is not zero-popup ready for ${owner}; sign out and back in`);
  }

  const para = new Para(Environment.PROD, PARA_API_KEY);
  if (data.session && typeof para.importSession === "function") {
    await para.importSession(data.session);
  } else {
    throw new Error(`Para importSession unavailable for ${owner}`);
  }

  return createParaViemClient({
    para,
    walletClientConfig: {
      chain: monad,
      transport: MONAD_TRANSPORT,
    },
  });
}

async function sendViaPara(owner, tx) {
  let gas = tx.gas;
  if (!gas) {
    try {
      gas = await publicClient.estimateGas({
        account: lower(owner),
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      gas = (gas * 13n) / 10n;
    } catch {
      if (!tx.data) gas = 42_000n;
    }
  }
  const client = await paraClientFor(owner);
  const req = {
    chain: monad,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas,
  };
  try {
    return await client.sendTransaction(req);
  } catch (err) {
    const msg = String(err?.shortMessage || err?.message || err);
    if (!/rpc request failed|network|timeout|fetch/i.test(msg)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 900));
    return client.sendTransaction(req);
  }
}

async function fireWithPara(row) {
  const owner = lower(row.owner_address);
  const token = lower(row.token_address);
  const side = row.side;
  const isBuy = side === "BUY";
  const amountIn = asBigInt(row.amount_in);
  const source = row.source === "limit" ? "LIMIT" : row.source === "copy" ? "COPY" : "MARKET";
  const feeBps = BigInt(Number(env[`FEE_BPS_${source}`] ?? env.FEE_BPS_MARKET ?? "0"));
  const feeAmount = 0n;
  const netIn = amountIn;

  if (isBuy && isAddress(FEE_WALLET) && feeBps > 0n) {
    log("executor", "buy fee transfer skipped; executing swap without pre-fee tx");
  }

  const slippageBps = Number(row.slippage_bps || 50);
  try {
    return await fireDirol({ owner, token, side, amountIn, netIn, slippageBps });
  } catch (err) {
    log("executor", "Dirol route failed, falling back to direct Nad.fun route:", err?.shortMessage || err?.message || err);
    return fireNadfun({ owner, token, side, amountIn, netIn, slippageBps });
  }
}

async function getDirolSwap({ owner, token, side, amountIn, netIn, slippageBps }) {
  const isBuy = side === "BUY";
  const q = new URLSearchParams({
    tokenIn: isBuy ? WMON : token,
    tokenOut: isBuy ? token : WMON,
    amount: (isBuy ? netIn : amountIn).toString(),
    recipient: owner,
    slippageBps: String(slippageBps || 50),
  });
  const res = await fetch(`${DIROL_BASE}/swap?${q}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dirol /swap ${res.status}: ${await res.text().catch(() => "")}`);
  const swap = await res.json();
  if (!isAddress(swap?.tx?.to) || !String(swap?.tx?.data || "").startsWith("0x")) {
    throw new Error("dirol /swap returned an invalid transaction");
  }
  return swap;
}

async function fireDirol({ owner, token, side, amountIn, netIn, slippageBps }) {
  const isBuy = side === "BUY";
  const swap = await getDirolSwap({ owner, token, side, amountIn, netIn, slippageBps });

  if (!isBuy) {
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [swap.tx.to, amountIn],
    });
    const approveHash = await sendViaPara(owner, { to: token, data: approveData });
    await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
  }

  return sendViaPara(owner, {
    to: swap.tx.to,
    data: swap.tx.data,
    value: isBuy ? netIn : BigInt(swap.tx.value || "0"),
    gas: swap.tx.estimatedGas ? BigInt(swap.tx.estimatedGas) : undefined,
  });
}

async function nadfunTokenVersion(token) {
  try {
    const res = await fetch(`${NADFUN_BASE}/token/metadata/${token}`, {
      headers: { accept: "application/json", ...(NADFUN_KEY ? { "X-API-Key": NADFUN_KEY } : {}) },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const version = json?.token_info?.version;
    return version === "V1" || version === "V2" ? version : null;
  } catch {
    return null;
  }
}

function applySlippage(amount, slippageBps) {
  if (amount <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Number(slippageBps || 50))));
  return amount - (amount * bps) / 10000n;
}

async function getNadfunRoute(token, amountIn, isBuy) {
  const version = await nadfunTokenVersion(token);
  if (version !== "V1") {
    try {
      const amountOut = await publicClient.readContract({
        address: NADFUN_ROUTER,
        abi: NADFUN_ROUTER_ABI,
        functionName: "getAmountOut",
        args: [token, amountIn, isBuy],
      });
      return { kind: "v2", router: NADFUN_ROUTER, amountOut };
    } catch {
      if (version === "V2") throw new Error("Nad.fun V2 quote failed for this token");
    }
  }

  const [router, amountOut] = await publicClient.readContract({
    address: NADFUN_LEGACY_LENS,
    abi: NADFUN_LEGACY_LENS_ABI,
    functionName: "getAmountOut",
    args: [token, amountIn, isBuy],
  });
  return { kind: "legacy", router, amountOut };
}

async function fireNadfun({ owner, token, side, amountIn, netIn, slippageBps }) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const isBuy = side === "BUY";
  const route = await getNadfunRoute(token, isBuy ? netIn : amountIn, isBuy);
  const amountOutMin = applySlippage(route.amountOut, slippageBps);

  if (route.kind === "v2" && side === "BUY") {
    const data = encodeFunctionData({
      abi: NADFUN_ROUTER_ABI,
      functionName: "buyWithNative",
      args: [{ token, amountOutMin, to: owner, deadline }],
    });
    return sendViaPara(owner, { to: NADFUN_ROUTER, data, value: netIn });
  }

  if (route.kind === "legacy" && side === "BUY") {
    const data = encodeFunctionData({
      abi: NADFUN_LEGACY_ROUTER_ABI,
      functionName: "buy",
      args: [{ token, amountOutMin, to: owner, deadline }],
    });
    return sendViaPara(owner, { to: route.router, data, value: netIn });
  }

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [route.router, amountIn],
  });
  const approveHash = await sendViaPara(owner, { to: token, data: approveData });
  await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });

  const data = encodeFunctionData({
    abi: route.kind === "v2" ? NADFUN_ROUTER_ABI : NADFUN_LEGACY_ROUTER_ABI,
    functionName: route.kind === "v2" ? "sellToNative" : "sell",
    args: [{ token, amountIn, amountOutMin, to: owner, deadline }],
  });
  return sendViaPara(owner, { to: route.router, data });
}

async function insertExecution(row) {
  const { error } = await sb.from("execution_queue").insert(row);
  if (error && error.code !== "23505") throw error;
}

async function mirrorTrade(trade) {
  const { data: cfgs, error } = await sb
    .from("copy_configs")
    .select("*")
    .eq("target_address", lower(trade.account_address))
    .eq("status", "active");
  if (error) throw error;

  for (const cfg of cfgs || []) {
    if (trade.side === "BUY" && !cfg.mirror_buys) continue;
    if (trade.side === "SELL" && !cfg.mirror_sells) continue;

    const pctBps = percentToBps(cfg.buy_pct);
    let amountIn = trade.side === "BUY"
      ? (asBigInt(trade.quote_amount) * pctBps) / 10000n
      : (asBigInt(trade.token_amount) * pctBps) / 10000n;
    if (trade.side === "BUY") {
      const cap = decimalToWei(cfg.max_per_trade);
      if (cap > 0n && amountIn > cap) amountIn = cap;
    }
    if (amountIn <= 0n) continue;

    await insertExecution({
      owner_address: lower(cfg.owner_address),
      source: "copy",
      source_id: cfg.id,
      token_address: lower(trade.token_address),
      side: trade.side,
      amount_in: amountIn.toString(),
      slippage_bps: Number(env.COPY_SLIPPAGE_BPS || 100),
      venue: "auto",
      trigger_tx_hash: trade.tx_hash,
    });
    log("copy-trade", `queued ${trade.side} for ${short(cfg.owner_address)} from ${short(trade.account_address)}`);
  }
}

function startCopyTradeRealtime() {
  sb.channel("copy:trades")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, (payload) => {
      safe("copy-trade", () => mirrorTrade(payload.new));
    })
    .subscribe((status) => log("copy-trade", `realtime ${status}`));
}

async function limitOrderTick() {
  const { data: orders, error } = await sb
    .from("limit_orders")
    .select("*")
    .eq("status", "open")
    .limit(500);
  if (error) throw error;

  let triggered = 0;
  for (const order of orders || []) {
    if (order.expires_at && new Date(order.expires_at) < new Date()) {
      await sb.from("limit_orders").update({ status: "expired" }).eq("id", order.id);
      continue;
    }

    const { data: market } = await sb
      .from("token_markets")
      .select("price_usd")
      .eq("token_address", lower(order.token_address))
      .maybeSingle();
    const price = Number(market?.price_usd);
    if (!Number.isFinite(price)) continue;

    const hit = order.side === "BUY"
      ? price <= Number(order.limit_price_usd)
      : price >= Number(order.limit_price_usd);
    if (!hit) continue;

    const claim = await sb
      .from("limit_orders")
      .update({ status: "firing" })
      .eq("id", order.id)
      .eq("status", "open")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    await insertExecution({
      owner_address: lower(order.owner_address),
      source: "limit",
      source_id: order.id,
      token_address: lower(order.token_address),
      side: order.side,
      amount_in: String(order.amount_in),
      slippage_bps: Math.round(Number(order.slippage_pct || 1) * 100),
      venue: "auto",
    });
    triggered++;
  }
  if (triggered) log("limit-order", `triggered ${triggered}`);
}

async function executorTick() {
  const { data: pending, error } = await sb
    .from("execution_queue")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Number(env.EXECUTOR_BATCH_SIZE || 5));
  if (error) throw error;

  for (const row of pending || []) {
    const claim = await sb
      .from("execution_queue")
      .update({ status: "firing", error: null })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    try {
      const hash = row.pre_signed_tx
        ? await publicClient.sendRawTransaction({ serializedTransaction: row.pre_signed_tx })
        : await fireWithPara(row);

      await sb
        .from("execution_queue")
        .update({ status: "filled", tx_hash: hash, fired_at: new Date().toISOString() })
        .eq("id", row.id);

      if (row.source === "limit" && row.source_id) {
        await sb.from("limit_orders")
          .update({ status: "filled", tx_hash: hash, filled_at: new Date().toISOString() })
          .eq("id", row.source_id);
      }
      if (row.source === "copy" && row.source_id) {
        const { data: cfg } = await sb.from("copy_configs").select("copied_count").eq("id", row.source_id).maybeSingle();
        await sb.from("copy_configs").update({ copied_count: Number(cfg?.copied_count || 0) + 1 }).eq("id", row.source_id);
      }
      log("executor", `${row.source} ${row.side} ${short(row.token_address)} -> ${short(hash)}`);
    } catch (err) {
      const msg = String(err?.shortMessage || err?.message || err);
      await sb.from("execution_queue")
        .update({ status: "failed", error: msg, fired_at: new Date().toISOString() })
        .eq("id", row.id);
      if (row.source === "limit" && row.source_id) {
        await sb.from("limit_orders").update({ status: "failed" }).eq("id", row.source_id);
      }
      log("executor", `failed ${row.source} ${short(row.id)}: ${msg}`);
    }
  }
}

async function fireAlert(rule, title, body, link, meta = {}) {
  const last = rule.last_fired_at ? new Date(rule.last_fired_at).getTime() : 0;
  if (Date.now() - last < FIRE_COOLDOWN_MS) return false;
  await sb.from("alerts").update({ last_fired_at: new Date().toISOString() }).eq("id", rule.id);
  if (rule.push_inapp !== false) {
    await sb.from("notifications").insert({
      owner_address: lower(rule.owner_address),
      kind: `alert.${rule.kind}`,
      title,
      body,
      link,
      meta: { rule_id: rule.id, ...meta },
    });
  }
  return true;
}

async function alertsTick() {
  const { data: rules, error } = await sb.from("alerts").select("*").eq("enabled", true);
  if (error) throw error;
  if (!rules?.length) return;

  const tokens = [...new Set(rules
    .filter((r) => ["price", "progress", "volume", "holder"].includes(r.kind) && r.token_address)
    .map((r) => lower(r.token_address)))];
  const marketsByToken = new Map();
  if (tokens.length) {
    const { data: markets } = await sb
      .from("token_markets")
      .select("token_address, price_usd, volume_usd, holder_count, progress_bps")
      .in("token_address", tokens);
    for (const market of markets || []) marketsByToken.set(lower(market.token_address), market);
  }

  let fired = 0;
  for (const rule of rules) {
    if (!["price", "progress", "volume", "holder"].includes(rule.kind)) continue;
    const market = marketsByToken.get(lower(rule.token_address));
    if (!market) continue;
    const value = rule.kind === "price" ? market.price_usd
      : rule.kind === "volume" ? market.volume_usd
      : rule.kind === "holder" ? market.holder_count
      : Number(market.progress_bps || 0) / 100;
    if (!cmp(rule.comparator, value, rule.threshold)) continue;
    const didFire = await fireAlert(
      rule,
      `${rule.kind} alert`,
      `${short(rule.token_address)} is ${value} (${rule.comparator || ">="} ${rule.threshold})`,
      `/token/${rule.token_address}`,
      { value, threshold: rule.threshold },
    );
    if (didFire) fired++;
  }
  if (fired) log("alerts", `fired ${fired} threshold alerts`);
}

function startAlertsRealtime() {
  sb.channel("alerts:trades")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "trades" }, (payload) => {
      safe("alerts", async () => {
        const trade = payload.new;
        const { data: rules } = await sb.from("alerts")
          .select("*")
          .eq("enabled", true)
          .eq("kind", "wallet")
          .eq("wallet_address", lower(trade.account_address));
        for (const rule of rules || []) {
          await fireAlert(
            rule,
            `${trade.side} ${Number(trade.value_usd || 0).toFixed(2)} USD`,
            `${short(trade.account_address)} ${trade.side === "BUY" ? "bought" : "sold"} ${short(trade.token_address)}`,
            `/token/${trade.token_address}`,
            { tx_hash: trade.tx_hash },
          );
        }
      });
    })
    .subscribe((status) => log("alerts", `trades realtime ${status}`));

  sb.channel("alerts:launches")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "tokens" }, (payload) => {
      safe("alerts", async () => {
        const token = payload.new;
        if (!token.creator_address) return;
        const { data: rules } = await sb.from("alerts")
          .select("*")
          .eq("enabled", true)
          .eq("kind", "launch")
          .eq("wallet_address", lower(token.creator_address));
        for (const rule of rules || []) {
          await fireAlert(
            rule,
            `New launch: $${token.symbol || "???"}`,
            `${short(token.creator_address)} launched ${token.name || "a new token"}`,
            `/token/${token.address}`,
            { token_address: token.address },
          );
        }
      });
    })
    .subscribe((status) => log("alerts", `launch realtime ${status}`));
}

async function pnlTick() {
  for (const window of ["24H", "7D", "30D", "ALL"]) {
    const { error } = await sb.rpc("compute_pnl_snapshots", { p_window: window });
    if (error) log("pnl", `${window} skipped: ${error.message}`);
  }
}

async function smartMoneyTick() {
  const { data: rows, error } = await sb
    .from("pnl_snapshots")
    .select("*")
    .eq("time_window", "30D")
    .or("volume_usd.gte.250000,realized_usd.gte.2000,trades_count.gte.8")
    .limit(1000);
  if (error) throw error;

  const labels = [];
  for (const row of rows || []) {
    const volume = Number(row.volume_usd || 0);
    const realized = Number(row.realized_usd || 0);
    const winRate = Number(row.win_rate_pct || 0);
    const trades = Number(row.trades_count || 0);
    if (volume >= Number(env.SM_WHALE_VOLUME_USD || 250000)) {
      labels.push(labelRow(row.account_address, "whale", Math.round(volume), `30D volume $${Math.round(volume)}`));
    }
    if (realized >= Number(env.SM_SMART_MIN_PNL_USD || 2000) && winRate >= Number(env.SM_SMART_MIN_WINRATE_PCT || 55) && trades >= Number(env.SM_MIN_TRADES || 8)) {
      labels.push(labelRow(row.account_address, "smart_money", Math.round(realized * (winRate / 100)), `+$${Math.round(realized)} realized, ${winRate}% win rate`));
    }
    if (Number(row.best_trade_usd || 0) >= Number(env.SM_INSIDER_BEST_TRADE_USD || 25000)) {
      labels.push(labelRow(row.account_address, "insider_watch", Number(row.best_trade_usd), "Large best-trade outlier"));
    }
  }

  await sb.from("account_labels").delete().in("label", ["smart_money", "whale", "insider_watch"]);
  for (let i = 0; i < labels.length; i += 500) {
    const { error: upsertError } = await sb.from("account_labels").upsert(labels.slice(i, i + 500));
    if (upsertError) throw upsertError;
  }
  log("smart-money", `wrote ${labels.length} labels`);
}

function labelRow(account, label, score, reason) {
  return {
    account_address: lower(account),
    label,
    score,
    reason,
    computed_at: new Date().toISOString(),
  };
}

async function bubbleMapTick() {
  const { error } = await sb.rpc("recompute_bubble_map");
  if (error) log("bubble-map", `rpc skipped: ${error.message}`);
}

async function feedRankerTick() {
  const { error } = await sb.rpc("recompute_feed_rank");
  if (error) log("feed-ranker", `rpc skipped: ${error.message}`);
}

let redemptionWarned = false;
async function redemptionTick() {
  if (!env.FEE_WALLET_PRIVATE_KEY) {
    if (!redemptionWarned) {
      log("redemption", "FEE_WALLET_PRIVATE_KEY not set - idle");
      redemptionWarned = true;
    }
    return;
  }

  const { data: queue, error } = await sb
    .from("redemptions")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(5);
  if (error) throw error;

  const account = privateKeyToAccount(env.FEE_WALLET_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: monad, transport: viemHttp(RPC) });

  for (const redemption of queue || []) {
    const claim = await sb
      .from("redemptions")
      .update({ status: "firing" })
      .eq("id", redemption.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claim.error || !claim.data) continue;

    try {
      const hash = await wallet.sendTransaction({
        to: lower(redemption.owner_address),
        value: asBigInt(redemption.mon_amount),
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (rcpt.status !== "success") throw new Error(`redemption tx reverted (${hash})`);
      await sb.from("redemptions").update({
        status: "paid",
        tx_hash: hash,
        paid_at: new Date().toISOString(),
        error_msg: null,
      }).eq("id", redemption.id);
      log("redemption", `paid ${short(redemption.owner_address)} -> ${short(hash)}`);
    } catch (err) {
      await sb.from("redemptions").update({
        status: "failed",
        error_msg: String(err?.shortMessage || err?.message || err),
      }).eq("id", redemption.id);
    }
  }
}

console.log("booting workers");
startCopyTradeRealtime();
startAlertsRealtime();

loop("limit-order", Number(env.LIMIT_INTERVAL_MS || 10_000), limitOrderTick);
loop("executor", Number(env.EXECUTOR_INTERVAL_MS || 800), executorTick);
loop("alerts", Number(env.ALERT_INTERVAL_MS || 20_000), alertsTick);
loop("pnl", Number(env.PNL_INTERVAL_MS || 5 * 60_000), pnlTick);
loop("smart-money", Number(env.SMART_MONEY_INTERVAL_MS || 15 * 60_000), smartMoneyTick);
loop("bubble-map", Number(env.BUBBLE_MAP_INTERVAL_MS || 30 * 60_000), bubbleMapTick);
loop("feed-ranker", Number(env.FEED_RANKER_INTERVAL_MS || 60_000), feedRankerTick);
loop("redemption", Number(env.REDEMPTION_INTERVAL_MS || 30_000), redemptionTick);

setInterval(() => {
  gun.get("system").get("bot").put({ online: true, tokenDiscovery: false, updatedAt: new Date().toISOString() });
  log("heartbeat", `uptime=${Math.floor(process.uptime() / 60)}min`);
}, 5 * 60_000);

function shutdown() {
  log("bot", "shutting down");
  gun.get("system").get("bot").put({ online: false, updatedAt: new Date().toISOString() });
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err?.message || err);
});
