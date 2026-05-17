import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { z } from 'zod';
import {
  addChannelToCoin,
  addChannelToCoinByContract,
  getCoin,
  getCoinByContract,
  getPrimaryCoin,
  getTrackedChats,
  getTrendingCoins,
  readStore,
  recordBuyEvent,
  upsertCoin
} from './store.js';
import { renderBuyAlert, renderCoinList, renderTrendingList } from './render.js';

const {
  BOT_TOKEN,
  PORT = 3000,
  WEBHOOK_SECRET,
  HELIUS_AUTH_HEADER,
  HELIUS_API_KEY,
  HELIUS_WEBHOOK_ID,
  TELEGRAM_WEBHOOK_URL,
  BASE_URL,
  ALERT_CHAT_ID,
  SOLANA_RPC_HTTP = 'https://api.mainnet-beta.solana.com',
  DEFAULT_QUOTE_SYMBOL = 'SOL',
  TRENDING_LIMIT = 5
} = process.env;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required. Copy .env.example to .env and add your Telegram bot token.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const telegramWebhookPath = `/telegram/${BOT_TOKEN}`;
const telegramWebhookUrl = TELEGRAM_WEBHOOK_URL ?? (BASE_URL ? `${BASE_URL.replace(/\/$/, '')}${telegramWebhookPath}` : null);

app.use(express.json({ limit: '1mb' }));
app.use(telegramWebhookPath, bot.webhookCallback(telegramWebhookPath));

const buyEventSchema = z.object({
  symbol: z.string().min(1).optional(),
  contract: z.string().min(1).optional(),
  buyer: z.string().optional(),
  tokenAmount: z.coerce.number().nonnegative(),
  usdValue: z.coerce.number().nonnegative().default(0),
  quoteAmount: z.coerce.number().nonnegative().optional(),
  quoteSymbol: z.string().optional(),
  marketCap: z.coerce.number().nonnegative().optional(),
  dex: z.string().optional(),
  txUrl: z.string().url().optional()
}).refine((event) => event.symbol || event.contract, {
  message: 'Either symbol or contract is required.'
});

bot.start(showHelp);
bot.help(showHelp);

async function showHelp(ctx) {
  return ctx.reply([
    'Buy bot is online.',
    '',
    'Commands:',
    '/help - show this menu',
    '/coins - list tracked coins',
    '/trending - show 24h trending volume',
    '/chatid - show this Telegram chat id',
    '/chats - show tracked chats',
    '/track OGRE - add this chat/channel to a coin',
    '/setcoin SYMBOL CONTRACT - register this chat for a coin',
    '/testbuy OGRE - send a test buy alert',
    '/addcoin SYMBOL Name | chain | contract | buyUrl - register a coin',
    '',
    'Real buys come from the /api/buy webhook. Connect that to Helius, Moralis, Bitquery, or another Solana/Pump.fun listener.'
  ].join('\n'));
}

bot.command('coins', async (ctx) => {
  const store = await readStore();
  await ctx.reply(renderCoinList(store.coins), { disable_web_page_preview: true });
});

bot.command('trending', async (ctx) => {
  const primaryCoin = await getPrimaryCoin();
  const trending = await getTrendingCoins(Number(TRENDING_LIMIT));
  await ctx.reply(renderTrendingList(trending, primaryCoin), { disable_web_page_preview: true });
});

bot.command('chatid', async (ctx) => {
  await ctx.reply(`This chat id is: ${ctx.chat.id}`);
});

bot.command('chats', async (ctx) => {
  const chats = await getTrackedChats();
  if (chats.length === 0) {
    await ctx.reply('No chats are tracking coins yet.');
    return;
  }

  await ctx.reply(chats.map((item) => `${item.chatId} -> $${item.symbol} (${item.contract})`).join('\n'));
});

bot.command('sync_helius', async (ctx) => {
  const store = await readStore();
  const contracts = store.coins
    .filter((coin) => coin.enabled && coin.contract)
    .map((coin) => coin.contract);

  const heliusResult = await ensureHeliusTracksContracts(contracts);
  await ctx.reply(renderHeliusSyncStatus(heliusResult) || 'Helius sync did not run. Check env vars.');
});

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.update.my_chat_member;
  const chat = update.chat;
  const status = update.new_chat_member.status;

  if (['member', 'administrator'].includes(status)) {
    console.log(`Bot was added to chat ${chat.id} (${chat.title ?? chat.username ?? chat.type}). Use /setcoin SYMBOL CONTRACT in that chat to enable buy alerts.`);
  }
});

bot.command('track', async (ctx) => {
  const symbol = getUpdateText(ctx).split(/\s+/)[1];
  if (!symbol) {
    await ctx.reply('Usage: /track OGRE');
    return;
  }

  try {
    const coin = await addChannelToCoin(symbol, ctx.chat.id);
    const heliusResult = await ensureHeliusTracksContract(coin.contract);
    await ctx.reply([
      `This chat is now tracking $${coin.symbol}. Make sure the bot is admin if this is a channel.`,
      renderHeliusSyncStatus(heliusResult)
    ].filter(Boolean).join('\n'));
  } catch (error) {
    await ctx.reply(error.message);
  }
});

bot.command('setcoin', async (ctx) => {
  const text = getUpdateText(ctx);
  const [, symbol, contract, ...rest] = text.split(/\s+/);

  if (!symbol || !contract) {
    await ctx.reply('Usage: /setcoin SYMBOL CONTRACT');
    return;
  }

  const buyUrl = rest[0] || `https://pump.fun/coin/${contract}`;
  const coin = await addChannelToCoinByContract(contract, ctx.chat.id, {
    symbol,
    name: symbol.toUpperCase(),
    buyUrl,
    website: buyUrl
  });
  const heliusResult = await ensureHeliusTracksContract(coin.contract);

  await ctx.reply([
    `This chat is now tracking $${coin.symbol} buys for ${coin.contract}.`,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
});

bot.command('testbuy', async (ctx) => {
  const symbol = getUpdateText(ctx).split(/\s+/)[1] ?? 'OGRE';
  const coin = await getCoin(symbol);

  if (!coin?.enabled) {
    await ctx.reply(`Unknown coin: ${symbol}`);
    return;
  }

  await postBuyAlert({
    coin,
    eventInput: {
      symbol: coin.symbol,
      contract: coin.contract,
      buyer: 'TESTBUY1111111111111111111111111111111111',
      tokenAmount: 100000,
      usdValue: 123.45,
      quoteAmount: 1,
      quoteSymbol: DEFAULT_QUOTE_SYMBOL,
      dex: 'test',
      txUrl: coin.website
    }
  });

  await ctx.reply(`Sent a test buy alert for $${coin.symbol}.`);
});

bot.command('addcoin', async (ctx) => {
  const payload = getUpdateText(ctx).replace(/^\/addcoin(@\w+)?\s*/i, '').trim();
  const match = payload.match(/^(\S+)\s+([^|]+)\|([^|]+)\|([^|]+)\|(.+)$/);

  if (!match) {
    await ctx.reply('Usage: /addcoin SYMBOL Name | chain | contract | buyUrl');
    return;
  }

  const [, symbol, name, chain, contract, buyUrl] = match;
  const coin = await upsertCoin({
    symbol,
    name: name.trim(),
    chain: chain.trim(),
    contract: contract.trim(),
    buyUrl: buyUrl.trim(),
    channels: [String(ctx.chat.id)]
  });
  const heliusResult = await ensureHeliusTracksContract(coin.contract);

  await ctx.reply([
    `Added $${coin.symbol} and linked it to this chat.`,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
});

app.get('/', (_req, res) => {
  res.send('OGRE buy bot is running.');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/debug/coins', async (_req, res) => {
  const store = await readStore();
  res.json({
    ok: true,
    coins: store.coins.map((coin) => ({
      symbol: coin.symbol,
      contract: coin.contract,
      enabled: coin.enabled,
      channels: coin.channels ?? []
    }))
  });
});

app.get('/api/test-alert/:symbol', async (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET && req.header('x-bot-secret') !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  const coin = await getCoin(req.params.symbol);
  if (!coin?.enabled) {
    res.status(404).json({ error: `Unknown coin: ${req.params.symbol}` });
    return;
  }

  const { event, results, duplicate } = await postBuyAlert({
    coin,
    eventInput: {
      symbol: coin.symbol,
      contract: coin.contract,
      buyer: 'LIVECHECK111111111111111111111111111111111',
      tokenAmount: 100000,
      usdValue: 123.45,
      quoteAmount: 1,
      quoteSymbol: DEFAULT_QUOTE_SYMBOL,
      buyerSolBalance: 5.25,
      dex: 'render-test',
      txUrl: coin.website
    }
  });

  res.json({
    ok: true,
    duplicate: Boolean(duplicate),
    channels: coin.channels ?? [],
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results
      .map((result, index) => ({ result, chatId: coin.channels?.[index] }))
      .filter((item) => item.result.status === 'rejected')
      .map((item) => ({
        chatId: item.chatId,
        error: item.result.reason?.description ?? item.result.reason?.message ?? String(item.result.reason)
      })),
    event
  });
});

app.get('/api/test-alert-contract/:contract', async (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET && req.header('x-bot-secret') !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  const coin = await getCoinByContract(req.params.contract);
  if (!coin?.enabled) {
    res.status(404).json({ error: `Unknown contract: ${req.params.contract}` });
    return;
  }

  const { event, results, duplicate } = await postBuyAlert({
    coin,
    eventInput: {
      symbol: coin.symbol,
      contract: coin.contract,
      buyer: 'LIVECHECK111111111111111111111111111111111',
      tokenAmount: 100000,
      usdValue: 123.45,
      quoteAmount: 1,
      quoteSymbol: DEFAULT_QUOTE_SYMBOL,
      buyerSolBalance: 5.25,
      dex: 'render-test',
      txUrl: coin.website || coin.buyUrl
    }
  });

  res.json({
    ok: true,
    duplicate: Boolean(duplicate),
    channels: getAlertChannels(coin),
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results
      .map((result, index) => ({ result, chatId: getAlertChannels(coin)[index] }))
      .filter((item) => item.result.status === 'rejected')
      .map((item) => ({
        chatId: item.chatId,
        error: item.result.reason?.description ?? item.result.reason?.message ?? String(item.result.reason)
      })),
    event
  });
});

app.post('/api/buy', async (req, res) => {
  if (WEBHOOK_SECRET && req.header('x-bot-secret') !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  const parsed = buyEventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const coin = parsed.data.contract
    ? await getCoinByContract(parsed.data.contract)
    : await getCoin(parsed.data.symbol);

  if (!coin?.enabled) {
    res.status(404).json({ error: `Coin is not registered or is disabled.` });
    return;
  }

  const { event, results } = await postBuyAlert({ coin, eventInput: parsed.data });

  res.json({
    ok: true,
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
    event
  });
});

app.post('/api/helius', async (req, res) => {
  if (!isValidHeliusAuth(req.header('authorization'))) {
    res.status(401).json({ error: 'Invalid Helius authorization header' });
    return;
  }

  await saveLastHeliusPayload(req.body);

  const transactions = Array.isArray(req.body) ? req.body : [req.body];
  const accepted = [];
  const ignored = [];

  for (const transaction of transactions) {
    const events = await parseHeliusTransaction(transaction);

    for (const eventInput of events) {
      const coin = await getCoinByContract(eventInput.contract);

      if (!coin?.enabled) {
        ignored.push({ reason: 'untracked-contract', contract: eventInput.contract });
        continue;
      }

      const result = await postBuyAlert({ coin, eventInput });
      if (result.duplicate) {
        ignored.push({ reason: 'duplicate', signature: eventInput.txSignature });
      } else {
        accepted.push({ symbol: coin.symbol, signature: eventInput.txSignature });
      }
    }
  }

  res.json({ ok: true, accepted, ignored });
});

app.get('/api/helius/last', async (_req, res) => {
  try {
    const raw = await fs.readFile(path.resolve('data', 'last-helius-payload.json'), 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'No Helius payload has reached this bot yet.' });
  }
});

bot.catch((error, ctx) => {
  console.error(`Telegram error for update ${ctx.update?.update_id ?? 'unknown'}:`, error);
});

async function main() {
  app.listen(Number(PORT), () => {
    console.log(`Buy bot API listening on http://localhost:${PORT}`);
  });

  const me = await bot.telegram.getMe();
  console.log(`Telegram bot connected as @${me.username}`);

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show bot commands' },
    { command: 'coins', description: 'List tracked coins' },
    { command: 'trending', description: 'Show 24h trending volume' },
    { command: 'chatid', description: 'Show this chat id' },
    { command: 'chats', description: 'Show tracked chats' },
    { command: 'sync_helius', description: 'Sync tracked CAs to Helius' },
    { command: 'track', description: 'Track a coin in this chat' },
    { command: 'setcoin', description: 'Register this chat for a coin CA' },
    { command: 'testbuy', description: 'Send a test buy alert' },
    { command: 'addcoin', description: 'Register another coin' }
  ]);

  if (telegramWebhookUrl) {
    await bot.telegram.setWebhook(telegramWebhookUrl, {
      drop_pending_updates: true
    });
    console.log(`Telegram webhook set to ${telegramWebhookUrl}`);
  } else {
    await bot.telegram.deleteWebhook({
      drop_pending_updates: true
    });
    await bot.launch({
      dropPendingUpdates: true
    });
    console.log('Telegram polling started. Leave this window open.');
  }
}

main().catch((error) => {
  console.error('Bot failed to start.');
  console.error(error);

  if (String(error.message ?? '').includes('409')) {
    console.error('Another copy of this bot is already running. Close the other terminal/process and try again.');
  }

  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

function getUpdateText(ctx) {
  return ctx.message?.text ?? ctx.channelPost?.text ?? '';
}

async function postBuyAlert({ coin, eventInput }) {
  const event = await recordBuyEvent({
    ...eventInput,
    symbol: coin.symbol,
    contract: eventInput.contract ?? coin.contract,
    quoteSymbol: eventInput.quoteSymbol ?? DEFAULT_QUOTE_SYMBOL
  });

  if (!event) {
    return { duplicate: true, results: [] };
  }

  const trending = await getTrendingCoins(Number(TRENDING_LIMIT));
  const primaryCoin = await getPrimaryCoin();
  const message = renderBuyAlert({ coin, event, trending, primaryCoin });
  const channels = getAlertChannels(coin);

  const results = await Promise.allSettled(
    channels.map((chatId) => bot.telegram.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to send $${coin.symbol} buy alert to chat ${channels[index]}:`, result.reason);
    }
  });

  return { event, results };
}

function getAlertChannels(coin) {
  const configuredChannels = coin.channels ?? [];
  const envChannels = ALERT_CHAT_ID
    ? ALERT_CHAT_ID.split(',').map((chatId) => chatId.trim()).filter(Boolean)
    : [];

  return Array.from(new Set([...configuredChannels, ...envChannels]));
}

async function parseHeliusTransaction(transaction) {
  const tokenTransfers = [
    ...(transaction.tokenTransfers ?? []),
    ...getSwapTokenOutputs(transaction)
  ];
  const nativeTransfers = transaction.nativeTransfers ?? [];
  const signature = transaction.signature;
  const source = transaction.source ?? transaction.type ?? 'helius';
  const events = [];

  for (const transfer of tokenTransfers) {
    const contract = transfer.mint;
    if (!contract) continue;

    const buyer = transfer.toUserAccount;
    if (!buyer) continue;

    const solSpent = getSolSpentByWallet(transaction, nativeTransfers, buyer);
    if (solSpent <= 0) continue;

    const buyerSolBalance = await getSolBalance(buyer);
    const priceUsd = await getTokenPriceUsd(contract);
    const tokenAmount = Number(transfer.tokenAmount ?? 0);
    if (tokenAmount <= 0) continue;

    events.push({
      contract,
      buyer,
      tokenAmount,
      usdValue: priceUsd ? tokenAmount * priceUsd : 0,
      quoteAmount: solSpent || undefined,
      quoteSymbol: 'SOL',
      buyerSolBalance,
      dex: source,
      txSignature: signature,
      txUrl: signature ? `https://solscan.io/tx/${signature}` : undefined
    });
  }

  return events;
}

function getSwapTokenOutputs(transaction) {
  const outputs = transaction.events?.swap?.tokenOutputs ?? [];

  return outputs.map((output) => ({
    mint: output.mint,
    toUserAccount: output.userAccount ?? output.toUserAccount ?? output.account,
    tokenAmount: output.tokenAmount ?? parseRawTokenAmount(output.rawTokenAmount)
  }));
}

function parseRawTokenAmount(rawTokenAmount) {
  if (!rawTokenAmount) return undefined;

  const amount = Number(rawTokenAmount.tokenAmount ?? rawTokenAmount.amount);
  const decimals = Number(rawTokenAmount.decimals ?? 0);
  if (!Number.isFinite(amount)) return undefined;

  return amount / 10 ** decimals;
}

function getSolSpentByWallet(transaction, nativeTransfers, wallet) {
  const lamportsSpent = nativeTransfers
    .filter((nativeTransfer) => nativeTransfer.fromUserAccount === wallet)
    .reduce((total, nativeTransfer) => total + Number(nativeTransfer.amount ?? 0), 0);

  if (lamportsSpent > 0) {
    return lamportsSpent / 1_000_000_000;
  }

  const swapNativeInput = transaction.events?.swap?.nativeInput;
  if (swapNativeInput?.amount) {
    const accountMatches = !swapNativeInput.account || swapNativeInput.account === wallet;
    if (accountMatches) {
      return Number(swapNativeInput.amount) / 1_000_000_000;
    }
  }

  const balanceChange = (transaction.accountData ?? [])
    .filter((account) => account.account === wallet && Number(account.nativeBalanceChange ?? 0) < 0)
    .reduce((total, account) => total + Math.abs(Number(account.nativeBalanceChange ?? 0)), 0);

  return balanceChange / 1_000_000_000;
}

async function getTokenPriceUsd(contract) {
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${contract}`);
    if (!response.ok) return undefined;

    const pairs = await response.json();
    const bestPair = Array.isArray(pairs)
      ? pairs.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0]
      : null;
    const price = Number(bestPair?.priceUsd);

    return Number.isFinite(price) && price > 0 ? price : undefined;
  } catch (error) {
    console.error(`Could not fetch USD price for ${contract}:`, error.message);
    return undefined;
  }
}

async function getSolBalance(wallet) {
  try {
    const response = await fetch(SOLANA_RPC_HTTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [wallet]
      })
    });
    const body = await response.json();
    const lamports = body.result?.value;
    return typeof lamports === 'number' ? lamports / 1_000_000_000 : undefined;
  } catch (error) {
    console.error(`Could not fetch SOL balance for ${wallet}:`, error.message);
    return undefined;
  }
}

async function ensureHeliusTracksContract(contract) {
  if (!contract) {
    return { ok: false, skipped: true, message: 'No contract provided.' };
  }

  return ensureHeliusTracksContracts([contract]);
}

async function ensureHeliusTracksContracts(contracts) {
  const uniqueContracts = Array.from(new Set(
    contracts
      .map((contract) => String(contract ?? '').trim())
      .filter(Boolean)
  ));

  if (uniqueContracts.length === 0) {
    return { ok: false, skipped: true, message: 'No contracts to sync.' };
  }

  if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) {
    return {
      ok: false,
      skipped: true,
      message: 'Helius auto-sync skipped. Set HELIUS_API_KEY and HELIUS_WEBHOOK_ID on Render.'
    };
  }

  try {
    const webhook = await fetchHeliusWebhook();
    const currentAddresses = webhook.accountAddresses ?? [];
    const nextAddresses = Array.from(new Set([...currentAddresses, ...uniqueContracts]));
    const added = nextAddresses.length - currentAddresses.length;

    if (added === 0) {
      return { ok: true, added: 0, total: nextAddresses.length, message: 'Helius already tracks this CA.' };
    }

    await updateHeliusWebhook({
      ...webhook,
      accountAddresses: nextAddresses
    });

    return {
      ok: true,
      added,
      total: nextAddresses.length,
      message: `Helius synced ${added} new CA${added === 1 ? '' : 's'}.`
    };
  } catch (error) {
    console.error('Helius auto-sync failed:', error);
    return {
      ok: false,
      message: `Helius auto-sync failed: ${error.message}`
    };
  }
}

async function fetchHeliusWebhook() {
  const response = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`);
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error ?? body.message ?? `Helius GET failed with ${response.status}`);
  }

  return body;
}

async function updateHeliusWebhook(webhook) {
  const response = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: webhook.webhookURL,
      transactionTypes: webhook.transactionTypes?.length ? webhook.transactionTypes : ['ANY'],
      accountAddresses: webhook.accountAddresses ?? [],
      webhookType: webhook.webhookType ?? 'enhanced',
      authHeader: webhook.authHeader,
      encoding: webhook.encoding,
      txnStatus: webhook.txnStatus
    })
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error ?? body.message ?? `Helius PUT failed with ${response.status}`);
  }

  return body;
}

function renderHeliusSyncStatus(result) {
  if (!result) return '';
  if (result.ok) return result.message;
  return result.message ? `Warning: ${result.message}` : '';
}

function isValidHeliusAuth(authHeader) {
  if (!HELIUS_AUTH_HEADER) return true;
  return authHeader === HELIUS_AUTH_HEADER || authHeader === `Bearer ${HELIUS_AUTH_HEADER}`;
}

async function saveLastHeliusPayload(payload) {
  try {
    await fs.mkdir(path.resolve('data'), { recursive: true });
    await fs.writeFile(
      path.resolve('data', 'last-helius-payload.json'),
      `${JSON.stringify({ receivedAt: new Date().toISOString(), payload }, null, 2)}\n`,
      'utf8'
    );
    console.log('Received Helius webhook payload.');
  } catch (error) {
    console.error('Could not save Helius debug payload:', error.message);
  }
}
