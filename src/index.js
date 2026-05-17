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
  DEBUG_HELIUS_CHAT_ID,
  DEBUG_HELIUS_NOTIFICATIONS = 'false',
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
let botUsername = '';

app.use(bot.webhookCallback(telegramWebhookPath));
app.use(express.json({ limit: '1mb' }));

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
    '/setca SYMBOL CONTRACT - same as /setcoin',
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

bot.command(['setcoin', 'setca'], async (ctx) => {
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

bot.on('channel_post', handleFallbackCommand);
bot.on('message', handleFallbackCommand);

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

app.get('/api/telegram/info', async (_req, res) => {
  const webhookInfo = await bot.telegram.getWebhookInfo();
  res.json({
    ok: true,
    botUsername,
    webhookInfo
  });
});

app.get('/api/telegram/reset-webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  if (!telegramWebhookUrl) {
    res.status(400).json({ error: 'BASE_URL or TELEGRAM_WEBHOOK_URL is required to set Telegram webhook.' });
    return;
  }

  await bot.telegram.setWebhook(telegramWebhookUrl, {
    drop_pending_updates: true,
    allowed_updates: ['message', 'channel_post', 'my_chat_member']
  });
  const webhookInfo = await bot.telegram.getWebhookInfo();

  res.json({
    ok: true,
    telegramWebhookUrl,
    webhookInfo
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
  const result = await processHeliusPayload(req.body);
  await notifyHeliusDebug(req.body, result);

  res.json(result);
});

app.get('/api/helius/replay-last', async (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Invalid secret' });
    return;
  }

  try {
    const raw = await fs.readFile(path.resolve('data', 'last-helius-payload.json'), 'utf8');
    const debugPayload = JSON.parse(raw);
    const result = await processHeliusPayload(debugPayload.payload);
    res.json({ ...result, replayed: true });
  } catch (error) {
    res.status(404).json({ error: 'No saved Helius payload to replay.', detail: error.message });
  }
});

async function processHeliusPayload(payload) {
  const transactions = Array.isArray(payload) ? payload : [payload];
  const accepted = [];
  const ignored = [];

  for (const transaction of transactions) {
    const events = await parseHeliusTransaction(transaction);

    if (events.length === 0) {
      ignored.push({
        reason: 'no-buy-events-parsed',
        signature: transaction.signature,
        type: transaction.type,
        source: transaction.source,
        mintsSeen: getMintsSeen(transaction).slice(0, 10)
      });
    }

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

  return { ok: true, accepted, ignored };
}

async function notifyHeliusDebug(payload, result) {
  if (String(DEBUG_HELIUS_NOTIFICATIONS).toLowerCase() !== 'true') return;

  const debugChatId = DEBUG_HELIUS_CHAT_ID || ALERT_CHAT_ID;
  if (!debugChatId) return;

  const transactions = Array.isArray(payload) ? payload : [payload];
  const summary = [
    '<b>Helius webhook hit</b>',
    `Transactions: ${transactions.length}`,
    `Accepted buys: ${result.accepted.length}`,
    `Ignored: ${result.ignored.length}`,
    ...transactions.slice(0, 3).map((tx, index) => {
      const signature = tx.signature ? `${String(tx.signature).slice(0, 8)}...${String(tx.signature).slice(-6)}` : 'none';
      return `${index + 1}. ${tx.type ?? 'unknown'} / ${tx.source ?? 'unknown'} / ${signature}`;
    }),
    result.ignored[0] ? `First ignored: ${result.ignored[0].reason}` : null
  ].filter(Boolean).join('\n');

  try {
    await bot.telegram.sendMessage(debugChatId, summary, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Could not send Helius debug notification:', error.message);
  }
}

app.get('/api/helius/last', async (_req, res) => {
  try {
    const raw = await fs.readFile(path.resolve('data', 'last-helius-payload.json'), 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'No Helius payload has reached this bot yet.' });
  }
});

app.get('/api/helius/last-summary', async (_req, res) => {
  try {
    const raw = await fs.readFile(path.resolve('data', 'last-helius-payload.json'), 'utf8');
    const debugPayload = JSON.parse(raw);
    const transactions = Array.isArray(debugPayload.payload) ? debugPayload.payload : [debugPayload.payload];
    res.json({
      ok: true,
      receivedAt: debugPayload.receivedAt,
      transactions: transactions.map((tx) => ({
        signature: tx.signature,
        type: tx.type,
        source: tx.source,
        feePayer: tx.feePayer,
        mintsSeen: getMintsSeen(tx),
        tokenTransfers: (tx.tokenTransfers ?? []).length,
        nativeTransfers: (tx.nativeTransfers ?? []).length,
        accountData: (tx.accountData ?? []).length,
        hasSwapEvent: Boolean(tx.events?.swap)
      }))
    });
  } catch (error) {
    res.status(404).json({ error: 'No saved Helius payload to summarize.', detail: error.message });
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
  botUsername = me.username;
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
    { command: 'setca', description: 'Register this chat for a coin CA' },
    { command: 'testbuy', description: 'Send a test buy alert' },
    { command: 'addcoin', description: 'Register another coin' }
  ]);

  if (telegramWebhookUrl) {
    await bot.telegram.setWebhook(telegramWebhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'channel_post', 'my_chat_member']
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
  return ctx.message?.text
    ?? ctx.message?.caption
    ?? ctx.channelPost?.text
    ?? ctx.channelPost?.caption
    ?? '';
}

async function handleFallbackCommand(ctx) {
  const parsed = parseCommandFromText(getUpdateText(ctx));
  if (!parsed) return;

  const { command, args } = parsed;

  if (command === 'help' || command === 'start') {
    await showHelp(ctx);
    return;
  }

  if (command === 'chatid') {
    await ctx.reply(`This chat id is: ${ctx.chat.id}`);
    return;
  }

  if (command === 'chats') {
    await replyWithTrackedChats(ctx);
    return;
  }

  if (command === 'setcoin' || command === 'setca') {
    await setCoinForChat(ctx, args);
    return;
  }

  if (command === 'track') {
    await trackSymbolForChat(ctx, args[0]);
    return;
  }

  if (command === 'testbuy') {
    await sendTestBuy(ctx, args[0] ?? 'OGRE');
  }
}

function parseCommandFromText(rawText) {
  let text = rawText.trim();
  if (!text) return null;

  const mentionPattern = botUsername ? new RegExp(`^@${escapeRegExp(botUsername)}\\b\\s*`, 'i') : /^@\w+\b\s*/i;
  text = text.replace(mentionPattern, '').trim();

  if (!text.startsWith('/')) {
    const firstWord = text.split(/\s+/)[0]?.toLowerCase();
    const mentionOnlyCommands = new Set(['help', 'start', 'chatid', 'chats', 'setcoin', 'setca', 'track', 'testbuy']);
    if (!mentionOnlyCommands.has(firstWord)) return null;
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.replace(/^\//, '').split('@')[0].toLowerCase();
  return { command, args };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function replyWithTrackedChats(ctx) {
  const chats = await getTrackedChats();
  if (chats.length === 0) {
    await ctx.reply('No chats are tracking coins yet.');
    return;
  }

  await ctx.reply(chats.map((item) => `${item.chatId} -> $${item.symbol} (${item.contract})`).join('\n'));
}

async function setCoinForChat(ctx, args) {
  const [symbol, contract, buyUrlArg] = args;

  if (!symbol || !contract) {
    await ctx.reply('Usage: /setcoin SYMBOL CONTRACT');
    return;
  }

  const buyUrl = buyUrlArg || `https://pump.fun/coin/${contract}`;
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
}

async function trackSymbolForChat(ctx, symbol) {
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
}

async function sendTestBuy(ctx, symbol) {
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
  const tokenMeta = await getTokenMetadata(coin.contract);
  const message = renderBuyAlert({ coin, event, trending, primaryCoin, tokenMeta });
  const channels = getAlertChannels(coin);

  const results = await Promise.allSettled(
    channels.map((chatId) => sendBuyAlertToChat(chatId, message, tokenMeta?.imageUrl))
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to send $${coin.symbol} buy alert to chat ${channels[index]}:`, result.reason);
    }
  });

  return { event, results };
}

async function sendBuyAlertToChat(chatId, message, imageUrl) {
  if (imageUrl) {
    try {
      return await bot.telegram.sendPhoto(chatId, imageUrl, {
        caption: message,
        parse_mode: 'HTML'
      });
    } catch (error) {
      console.error(`Failed to send token image to ${chatId}, falling back to text:`, error.message);
    }
  }

  return bot.telegram.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

function getAlertChannels(coin) {
  const configuredChannels = coin.channels ?? [];
  const fallbackChannels = ALERT_CHAT_ID
    ? ALERT_CHAT_ID.split(',').map((chatId) => chatId.trim()).filter(Boolean)
    : [];

  if (configuredChannels.length > 0) {
    return Array.from(new Set(configuredChannels));
  }

  return Array.from(new Set(fallbackChannels));
}

async function parseHeliusTransaction(transaction) {
  const tokenTransfers = [
    ...(transaction.tokenTransfers ?? []),
    ...getSwapTokenOutputs(transaction),
    ...getTokenBalanceChangeOutputs(transaction)
  ];
  const nativeTransfers = transaction.nativeTransfers ?? [];
  const signature = transaction.signature;
  const source = transaction.source ?? transaction.type ?? 'helius';
  const events = [];

  for (const transfer of tokenTransfers) {
    const contract = transfer.mint;
    if (!contract) continue;

    const buyer = transfer.toUserAccount ?? transfer.userAccount ?? transaction.feePayer;
    if (!buyer) continue;

    const solSpent = getSolSpentByWallet(transaction, nativeTransfers, buyer);
    if (solSpent <= 0 && !isLikelySwapBuy(transaction)) continue;

    const buyerSolBalance = await getSolBalance(buyer);
    const priceUsd = await getTokenPriceUsd(contract);
    const tokenAmount = Number(transfer.tokenAmount ?? 0);
    if (tokenAmount <= 0) continue;

    events.push({
      contract,
      buyer,
      tokenAmount,
      usdValue: priceUsd ? tokenAmount * priceUsd : 0,
      quoteAmount: solSpent > 0 ? solSpent : undefined,
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

function getTokenBalanceChangeOutputs(transaction) {
  return (transaction.accountData ?? []).flatMap((account) => {
    return (account.tokenBalanceChanges ?? [])
      .map((change) => {
        const tokenAmount = getTokenAmountFromBalanceChange(change);
        return {
          mint: change.mint,
          toUserAccount: change.userAccount ?? account.account,
          tokenAmount
        };
      })
      .filter((change) => change.mint && Number(change.tokenAmount ?? 0) > 0);
  });
}

function getMintsSeen(transaction) {
  return Array.from(new Set([
    ...(transaction.tokenTransfers ?? []).map((transfer) => transfer.mint),
    ...getSwapTokenOutputs(transaction).map((transfer) => transfer.mint),
    ...getTokenBalanceChangeOutputs(transaction).map((transfer) => transfer.mint)
  ].filter(Boolean)));
}

function getTokenAmountFromBalanceChange(change) {
  const raw = change.rawTokenAmount;
  if (raw) {
    const amount = Number(raw.tokenAmount ?? raw.amount);
    const decimals = Number(raw.decimals ?? 0);
    if (Number.isFinite(amount)) return amount / 10 ** decimals;
  }

  return Number(change.tokenAmount ?? change.uiTokenAmount ?? 0);
}

function isLikelySwapBuy(transaction) {
  const type = String(transaction.type ?? '').toUpperCase();
  const source = String(transaction.source ?? '').toUpperCase();
  return type === 'SWAP'
    || Boolean(transaction.events?.swap)
    || source.includes('PUMP')
    || source.includes('RAYDIUM')
    || source.includes('JUPITER')
    || source.includes('METEORA');
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

async function getTokenMetadata(contract) {
  if (!contract) return null;

  const pumpMeta = await getPumpFunMetadata(contract);
  if (pumpMeta?.imageUrl || pumpMeta?.bondingProgress != null) {
    return pumpMeta;
  }

  const heliusMeta = await getHeliusAssetMetadata(contract);
  return heliusMeta ?? pumpMeta;
}

async function getPumpFunMetadata(contract) {
  try {
    const response = await fetch(`https://frontend-api-v3.pump.fun/coins/${contract}`);
    if (!response.ok) return null;

    const coin = await response.json();
    const complete = Boolean(coin.complete);
    const bondingProgress = getPumpFunBondingProgress(coin);

    return {
      source: 'pump.fun',
      name: coin.name,
      symbol: coin.symbol,
      imageUrl: coin.image_uri || coin.image || coin.metadata?.image,
      complete,
      bondingProgress
    };
  } catch (error) {
    console.error(`Could not fetch Pump.fun metadata for ${contract}:`, error.message);
    return null;
  }
}

function getPumpFunBondingProgress(coin) {
  const directProgress = Number(
    coin.bonding_curve_progress
      ?? coin.bondingCurveProgress
      ?? coin.graduationPercent
      ?? coin.progress
  );

  if (Number.isFinite(directProgress)) {
    return directProgress <= 1 ? directProgress * 100 : directProgress;
  }

  const usdMarketCap = Number(coin.usd_market_cap ?? coin.market_cap);
  const graduationMarketCap = Number(coin.king_of_the_hill_market_cap ?? coin.raydium_migration_market_cap ?? 69000);

  if (Number.isFinite(usdMarketCap) && Number.isFinite(graduationMarketCap) && graduationMarketCap > 0) {
    return Math.min(100, (usdMarketCap / graduationMarketCap) * 100);
  }

  return null;
}

async function getHeliusAssetMetadata(contract) {
  if (!HELIUS_API_KEY) return null;

  try {
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'get-asset',
        method: 'getAsset',
        params: { id: contract }
      })
    });
    const body = await response.json();
    const asset = body.result;

    return {
      source: 'helius',
      name: asset?.content?.metadata?.name,
      symbol: asset?.content?.metadata?.symbol,
      imageUrl: asset?.content?.links?.image
    };
  } catch (error) {
    console.error(`Could not fetch Helius asset metadata for ${contract}:`, error.message);
    return null;
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
