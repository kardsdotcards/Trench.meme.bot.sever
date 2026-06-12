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

const env = process.env;
const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PARA_REST_API_KEY = env.PARA_API_SECRET || env.PARA_REST_API_KEY || env.PARA_API_KEY || env.VITE_PARA_API_KEY;
const PARA_REST_BASE = (env.PARA_API_BASE || "https://api.getpara.com").replace(/\/$/, "");
const OPTIONAL = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "VITE_PARA_API_KEY",
  "PARA_API_SECRET",
  "PARA_REST_API_KEY",
  "PARA_API_BASE",
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
  !PARA_REST_API_KEY ? "PARA_API_SECRET or PARA_REST_API_KEY" : null,
].filter(Boolean);
if (missing.length) {
  console.error("[bot] fatal: missing required Railway variables:", missing.join(", "));
  console.error("[bot] set these in Railway > Service > Variables, then redeploy.");
  process.exit(1);
}

console.log("trench.meme bot - Para REST runtime");
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
  console.warn("[bot] PARA_API_SECRET is empty. Para REST signing will use PARA_REST_API_KEY/PARA_API_KEY if present.");
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
