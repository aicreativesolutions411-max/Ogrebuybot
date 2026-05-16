import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_PATH = path.resolve('data', 'coins.json');

export async function readStore() {
  const raw = await fs.readFile(DATA_PATH, 'utf8');
  return JSON.parse(raw);
}

export async function writeStore(store) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function getCoin(symbol) {
  const store = await readStore();
  return store.coins.find((coin) => coin.symbol.toUpperCase() === symbol.toUpperCase());
}

export async function getCoinByContract(contract) {
  const store = await readStore();
  return store.coins.find((coin) => coin.contract?.toLowerCase() === contract.toLowerCase());
}

export async function getPrimaryCoin() {
  const store = await readStore();
  return store.coins.find((coin) => coin.isPrimary && coin.enabled) ?? store.coins.find((coin) => coin.enabled);
}

export async function upsertCoin(nextCoin) {
  const store = await readStore();
  const symbol = nextCoin.symbol.toUpperCase();
  const existingIndex = store.coins.findIndex((coin) => coin.symbol.toUpperCase() === symbol);
  const normalized = {
    chain: 'unknown',
    channels: [],
    enabled: true,
    isPrimary: false,
    ...nextCoin,
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
