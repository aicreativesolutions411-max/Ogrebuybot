import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_PATH = path.resolve('data', 'coins.json');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STORE_ID = process.env.SUPABASE_STORE_ID || 'default';

export async function readStore() {
  if (hasSupabaseStore()) {
    const remoteStore = await readSupabaseStore();
    if (remoteStore) return remoteStore;

    const localStore = await readLocalStore();
    await writeSupabaseStore(localStore);
    return localStore;
  }

  return readLocalStore();
}

export async function writeStore(store) {
  if (hasSupabaseStore()) {
    await writeSupabaseStore(store);
    return;
  }

  await writeLocalStore(store);
}

export async function replaceStore(store) {
  const normalized = {
    coins: Array.isArray(store.coins) ? store.coins : [],
    events: Array.isArray(store.events) ? store.events : []
  };

  await writeStore(normalized);
  return normalized;
}

async function readLocalStore() {
  const raw = await fs.readFile(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

async function writeLocalStore(store) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function hasSupabaseStore() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function readSupabaseStore() {
  const url = `${SUPABASE_URL}/rest/v1/bot_store?id=eq.${encodeURIComponent(SUPABASE_STORE_ID)}&select=data`;
  const response = await fetch(url, {
    headers: supabaseHeaders()
  });

  if (!response.ok) {
    throw new Error(`Supabase read failed: ${response.status} ${await response.text()}`);
  }

  const rows = await response.json();
  return rows[0]?.data ?? null;
}

async function writeSupabaseStore(store) {
  const url = `${SUPABASE_URL}/rest/v1/bot_store`;
  const response = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders({
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify({
      id: SUPABASE_STORE_ID,
      data: store,
      updated_at: new Date().toISOString()
    })
  });

  if (!response.ok) {
    throw new Error(`Supabase write failed: ${response.status} ${await response.text()}`);
  }
}

export async function getCoin(symbol) {
  const store = await readStore();
  return store.coins.find((coin) => coin.symbol.toUpperCase() === symbol.toUpperCase());
}

export async function getCoinByContract(contract) {
  const store = await readStore();
  return store.coins.find((coin) => coin.contract?.toLowerCase() === contract.toLowerCase());
}

export async function getCoinsByChat(chatId) {
  const store = await readStore();
  const normalizedChatId = String(chatId);
  return store.coins.filter((coin) => (coin.channels ?? []).map(String).includes(normalizedChatId));
}

export async function getPrimaryCoin() {
  const store = await readStore();
  return store.coins.find((coin) => coin.isPrimary && coin.enabled) ?? store.coins.find((coin) => coin.enabled);
}

export async function upsertCoin(nextCoin) {
  const store = await readStore();
  const symbol = nextCoin.symbol.toUpperCase();
  const existingIndex = store.coins.findIndex((coin) => coin.symbol.toUpperCase() === symbol);
  const existing = existingIndex >= 0 ? store.coins[existingIndex] : {};
  const channels = Array.from(new Set([
    ...(existing.channels ?? []),
    ...(nextCoin.channels ?? [])
  ].map(String)));
  const normalized = {
    chain: 'unknown',
    channels,
    enabled: true,
    isPrimary: false,
    ...nextCoin,
    channels,
    symbol
  };

  if (existingIndex >= 0) {
    store.coins[existingIndex] = { ...store.coins[existingIndex], ...normalized };
  } else {
    store.coins.push(normalized);
  }

  await writeStore(store);
  return normalized;
}

export async function addChannelToCoin(symbol, chatId) {
  const store = await readStore();
  const coin = store.coins.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());

  if (!coin) {
    throw new Error(`Unknown coin: ${symbol}`);
  }

  const normalizedChatId = String(chatId);
  coin.channels = Array.from(new Set([...(coin.channels ?? []), normalizedChatId]));
  await writeStore(store);
  return coin;
}

export async function addChannelToCoinByContract(contract, chatId, defaults = {}) {
  const store = await readStore();
  const normalizedContract = contract.trim();
  let coin = store.coins.find((item) => item.contract?.toLowerCase() === normalizedContract.toLowerCase());

  if (!coin) {
    const symbol = (defaults.symbol || `COIN${store.coins.length + 1}`).toUpperCase();
    coin = {
      symbol,
      name: defaults.name || symbol,
      chain: defaults.chain || 'solana',
      contract: normalizedContract,
      emoji: defaults.emoji || '[BUY]',
      website: defaults.website || '',
      buyUrl: defaults.buyUrl || `https://pump.fun/coin/${normalizedContract}`,
      imageUrl: defaults.imageUrl || '',
      twitter: defaults.twitter || '',
      telegram: defaults.telegram || '',
      channels: [],
      isPrimary: false,
      enabled: true,
      adText: ''
    };
    store.coins.push(coin);
  } else {
    coin.symbol = (defaults.symbol || coin.symbol).toUpperCase();
    coin.name = defaults.name || coin.name;
    coin.website = defaults.website || coin.website;
    coin.buyUrl = defaults.buyUrl || coin.buyUrl;
    coin.imageUrl = defaults.imageUrl || coin.imageUrl;
    coin.twitter = defaults.twitter || coin.twitter;
    coin.telegram = defaults.telegram || coin.telegram;
  }

  const normalizedChatId = String(chatId);
  coin.channels = Array.from(new Set([...(coin.channels ?? []), normalizedChatId]));
  await writeStore(store);
  return coin;
}

export async function getTrackedChats() {
  const store = await readStore();
  return store.coins.flatMap((coin) => (coin.channels ?? []).map((chatId) => ({
    chatId,
    symbol: coin.symbol,
    contract: coin.contract
  })));
}

export async function recordBuyEvent(event) {
  const store = await readStore();

  if (event.txSignature && store.events.some((item) => item.txSignature === event.txSignature)) {
    return null;
  }

  const now = new Date().toISOString();
  const normalized = {
    id: randomUUID(),
    createdAt: now,
    ...event,
    symbol: event.symbol.toUpperCase()
  };

  store.events.unshift(normalized);
  store.events = store.events.slice(0, 5000);
  await writeStore(store);
  return normalized;
}

export async function getTrendingCoins(limit = 5) {
  const store = await readStore();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const scores = new Map();

  for (const event of store.events) {
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < dayAgo) continue;

    const key = event.symbol.toUpperCase();
    const current = scores.get(key) ?? { symbol: key, buys: 0, volumeUsd: 0 };
    current.buys += 1;
    current.volumeUsd += Number(event.usdValue ?? 0);
    scores.set(key, current);
  }

  return [...scores.values()]
    .sort((a, b) => b.volumeUsd - a.volumeUsd || b.buys - a.buys)
    .slice(0, limit)
    .map((score) => {
      const coin = store.coins.find((item) => item.symbol.toUpperCase() === score.symbol);
      return { ...score, coin };
    })
    .filter((item) => item.coin?.enabled);
}
