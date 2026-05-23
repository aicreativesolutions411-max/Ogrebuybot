import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Markup, Telegraf } from 'telegraf';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  addWarning,
  addChannelToCoin,
  addChannelToCoinByContract,
  clearWarnings,
  getCoin,
  getCoinByContract,
  getCoinsByChat,
  getGroupSettings,
  getKnownChats,
  getPrimaryCoin,
  getTrackedChats,
  getTrendingCoins,
  getWarnings,
  replaceStore,
  readStore,
  recordKnownChat,
  recordBuyEvent,
  updateGroupSettings,
  updateCoinChatSettings,
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
  ENABLE_HELIUS_POLLING = 'false',
  HELIUS_POLL_INTERVAL_MS = 15000,
  ENABLE_BITQUERY_STREAM = 'false',
  BITQUERY_TOKEN,
  ENABLE_PUMPPORTAL_STREAM = 'false',
  PUMPPORTAL_API_KEY,
  ENABLE_NATIVE_SOLANA_WATCHER = 'false',
  ENABLE_DEXSCREENER_POLLING = 'false',
  DEXSCREENER_POLL_INTERVAL_MS = 20000,
  TOKEN_METADATA_CACHE_MS = 30000,
  ADMIN_STATUS_CACHE_MS = 300000,
  ENABLE_KEEP_ALIVE = 'false',
  KEEP_ALIVE_URL,
  KEEP_ALIVE_INTERVAL_MS = 600000,
  TELEGRAM_BACKUP_CHAT_ID,
  SOLANA_WS_URL,
  TELEGRAM_WEBHOOK_URL,
  BASE_URL,
  ALERT_CHAT_ID,
  SOLANA_RPC_HTTP = 'https://api.mainnet-beta.solana.com',
  DEFAULT_QUOTE_SYMBOL = 'SOL',
  TRENDING_LIMIT = 5,
  MIN_BUY_SOL = 0.0001
} = process.env;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required. Copy .env.example to .env and add your Telegram bot token.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const telegramWebhookPath = `/telegram/${BOT_TOKEN}`;
const telegramWebhookUrl = TELEGRAM_WEBHOOK_URL ?? (BASE_URL ? `${BASE_URL.replace(/\/$/, '')}${telegramWebhookPath}` : null);
const TELEGRAM_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'my_chat_member'
];
let botUsername = '';
let botId = null;
const pendingSettings = new Map();
let bitquerySocket = null;
let bitqueryRestartTimer = null;
let pumpPortalSocket = null;
let pumpPortalRestartTimer = null;
let nativeSolanaConnection = null;
let nativeSolanaSubscriptionIds = [];
let telegramBackupChatId = TELEGRAM_BACKUP_CHAT_ID || '';
const nativeSolanaSeenSignatures = new Set();
const dexScreenerState = new Map();
const tokenMetadataCache = new Map();
const adminStatusCache = new Map();
const knownChatMemory = new Map();
const minBuySol = Math.max(0, Number(MIN_BUY_SOL) || 0.0001);
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const OGRE_TRADE_BOT_URL = 'https://t.me/ogretradebot';

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
  side: z.string().optional(),
  chartUrl: z.string().url().optional(),
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
    '/backup_here - use this chat/channel for backups',
    '/backup_now - post a backup to the backup chat',
    '/restore_backup - reply to a backup message to restore',
    '/track OGRE - add this chat/channel to a coin',
    '/setcoin SYMBOL CONTRACT - register this chat for a coin',
    '/setca SYMBOL CONTRACT - same as /setcoin',
    '/setmedia SYMBOL - reply to a photo/video or paste a media URL',
    '/clearmedia SYMBOL - use token metadata image again',
    '/setemoji SYMBOL emojis - customize alert emojis',
    '/setbuyemoji SYMBOL 0.25 emojis - scale emojis by SOL bought',
    '/buysettings SYMBOL topmovers|footer|bonding|socials on|off',
    '/autoca - auto setup from a CA or Pump.fun link in this chat',
    '/settings - show this chat buy settings',
    '/testbuy OGRE - send a test buy alert',
    '/addcoin SYMBOL Name | chain | contract | buyUrl - register a coin',
    '',
    'Group manager:',
    '/modsettings - show clickable group manager settings',
    '/rules - show group rules',
    '/setrules rules text - set group rules',
    '/welcome on|off - toggle welcome messages',
    '/setwelcome text - set welcome text, supports {user} and {chat}',
    '/antilinks on|off - delete links from non-admins',
    '/warn, /warnings, /clearwarns - warning tools',
    '/mute, /unmute, /kick, /ban, /unban - reply to a user or pass user id',
    '/clean 20 - delete recent messages',
    '/pin, /unpin - reply to a message to pin or unpin',
    '/slowmode 10|off - set group slowmode seconds',
    '/lock, /unlock - close or reopen chat messages',
    '/save name text, /get name, /notes, /delnote name - saved group notes',
    '/filter word reply, /filters, /stopfilter word - auto replies',
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
  const chatCoins = await getCoinsByChat(ctx.chat.id);
  if (chatCoins.length === 0) {
    await ctx.reply('This chat is not tracking any coins yet. Use /setcoin SYMBOL CONTRACT.');
    return;
  }

  await ctx.reply(chatCoins.map((coin) => `$${coin.symbol} -> ${coin.contract}`).join('\n'));
});

bot.command('sync_helius', async (ctx) => {
  const store = await readStore();
  const contracts = store.coins
    .filter((coin) => coin.enabled && coin.contract)
    .map((coin) => coin.contract);

  const heliusResult = await ensureHeliusTracksContracts(contracts);
  await ctx.reply(renderHeliusSyncStatus(heliusResult) || 'Helius sync did not run. Check env vars.');
});

bot.command('backup_here', async (ctx) => {
  telegramBackupChatId = String(ctx.chat.id);
  await sendTelegramBackup('Backup channel set from /backup_here.');
  await ctx.reply('This chat is now the Telegram backup channel. Backups will post here after setup changes.');
});

bot.command('backup_now', async (ctx) => {
  if (!telegramBackupChatId) telegramBackupChatId = String(ctx.chat.id);
  await sendTelegramBackup('Manual backup from /backup_now.');
  await ctx.reply('Backup posted.');
});

bot.command('restore_backup', async (ctx) => {
  const restored = await restoreTelegramBackupFromReply(ctx);
  if (restored) {
    await ctx.reply(`Restored backup: ${restored.coins.length} coins, ${restored.events.length} events, ${Object.keys(restored.groupSettings ?? {}).length} group settings.`);
    restartBitqueryStreamSoon();
    restartPumpPortalStreamSoon();
    restartNativeSolanaWatcherSoon();
  }
});

bot.command('scan_now', async (ctx) => {
  const result = await pollTrackedContractsOnce();
  await ctx.reply([
    'Manual chain scan finished.',
    `Scanned contracts: ${result.scannedContracts}`,
    `Accepted buys: ${result.accepted}`,
    `Ignored transactions: ${result.ignored}`
  ].join('\n'));
});

bot.on('my_chat_member', async (ctx) => {
  const update = ctx.update.my_chat_member;
  const chat = update.chat;
  const status = update.new_chat_member.status;
  adminStatusCache.delete(String(chat.id));

  if (['member', 'administrator'].includes(status)) {
    console.log(`Bot was added to chat ${chat.id} (${chat.title ?? chat.username ?? chat.type}). Use /setcoin SYMBOL CONTRACT in that chat to enable buy alerts.`);
    await rememberChat(chat, { force: true });

    try {
      const fullChat = await bot.telegram.getChat(chat.id);
      const text = buildChatDiscoveryText({ chat, fullChat });
      const contract = extractBestSolanaContract(text, { allowBare: true });

      if (contract && await isBotAdminInChat(chat.id)) {
        await autoTrackContractForChat({
          chatId: chat.id,
          chatTitle: fullChat.title ?? chat.title,
          chatUsername: fullChat.username ?? chat.username,
          contract,
          reply: (message) => bot.telegram.sendMessage(chat.id, message)
        });
      }
    } catch (error) {
      console.error(`Auto-CA scan failed for chat ${chat.id}:`, error.message);
    }
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
    await sendTelegramBackup(`Tracked $${coin.symbol} in chat ${ctx.chat.id}.`);
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
  restartBitqueryStreamSoon();
  restartPumpPortalStreamSoon();
  restartNativeSolanaWatcherSoon();

  await ctx.reply([
    `This chat is now tracking $${coin.symbol} buys for ${coin.contract}.`,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
  await sendTelegramBackup(`Set ${coin.symbol} ${coin.contract} for chat ${ctx.chat.id}.`);
});

bot.command('setmedia', async (ctx) => {
  await setMediaForChat(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('clearmedia', async (ctx) => {
  await clearMediaForChat(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('setemoji', async (ctx) => {
  await setEmojiForChat(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('setbuyemoji', async (ctx) => {
  await setBuyEmojiForChat(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('buysettings', async (ctx) => {
  await setBuySettingsForChat(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('autoca', async (ctx) => {
  await autoTrackContractFromChat(ctx, { force: true, notifyNoContract: true });
});

bot.command('settings', async (ctx) => {
  await replyWithBuySettings(ctx);
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
      chartUrl: getDexScreenerChartUrl(coin.contract)
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
  restartBitqueryStreamSoon();
  restartPumpPortalStreamSoon();
  restartNativeSolanaWatcherSoon();

  await ctx.reply([
    `Added $${coin.symbol} and linked it to this chat.`,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
  await sendTelegramBackup(`Added ${coin.symbol} ${coin.contract} for chat ${ctx.chat.id}.`);
});

bot.command('modsettings', async (ctx) => {
  await replyWithModSettings(ctx);
});

bot.command('rules', async (ctx) => {
  await replyWithRules(ctx);
});

bot.command('setrules', async (ctx) => {
  await setRulesForChat(ctx, getUpdateText(ctx).replace(/^\/setrules(@\w+)?\s*/i, ''));
});

bot.command('welcome', async (ctx) => {
  await setWelcomeToggle(ctx, getUpdateText(ctx).split(/\s+/)[1]);
});

bot.command('setwelcome', async (ctx) => {
  await setWelcomeText(ctx, getUpdateText(ctx).replace(/^\/setwelcome(@\w+)?\s*/i, ''));
});

bot.command('antilinks', async (ctx) => {
  await setAntiLinksToggle(ctx, getUpdateText(ctx).split(/\s+/)[1]);
});

bot.command('warn', async (ctx) => {
  await warnUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1), { source: 'command' });
});

bot.command('warnings', async (ctx) => {
  await replyWithWarnings(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('clearwarns', async (ctx) => {
  await clearUserWarnings(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('mute', async (ctx) => {
  await muteUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('unmute', async (ctx) => {
  await unmuteUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('kick', async (ctx) => {
  await kickUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('ban', async (ctx) => {
  await banUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('unban', async (ctx) => {
  await unbanUser(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('clean', async (ctx) => {
  await cleanRecentMessages(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('pin', async (ctx) => {
  await pinRepliedMessage(ctx);
});

bot.command('unpin', async (ctx) => {
  await unpinMessage(ctx);
});

bot.command('slowmode', async (ctx) => {
  await setSlowMode(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('lock', async (ctx) => {
  await lockChat(ctx);
});

bot.command('unlock', async (ctx) => {
  await unlockChat(ctx);
});

bot.command('save', async (ctx) => {
  await saveNote(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('get', async (ctx) => {
  await getNote(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('notes', async (ctx) => {
  await listNotes(ctx);
});

bot.command('delnote', async (ctx) => {
  await deleteNote(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('filter', async (ctx) => {
  await saveFilter(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.command('filters', async (ctx) => {
  await listFilters(ctx);
});

bot.command('stopfilter', async (ctx) => {
  await deleteFilter(ctx, getUpdateText(ctx).split(/\s+/).slice(1));
});

bot.on('channel_post', handleFallbackCommand);
bot.on('message', handleFallbackCommand);
bot.on('edited_message', handleFallbackCommand);
bot.on('edited_channel_post', handleFallbackCommand);
bot.on('callback_query', handleSettingsCallback);

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

app.get('/api/debug/chat/:chatId', async (req, res) => {
  const coins = await getCoinsByChat(req.params.chatId);
  res.json({
    ok: true,
    chatId: req.params.chatId,
    coins: coins.map((coin) => ({
      symbol: coin.symbol,
      contract: coin.contract,
      channels: coin.channels ?? [],
      imageUrl: coin.imageUrl,
      buyUrl: coin.buyUrl
    }))
  });
});

app.get('/api/debug/pump/:contract', async (req, res) => {
  const meta = await getPumpFunMetadata(req.params.contract);
  res.json({
    ok: true,
    contract: req.params.contract,
    meta
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

app.post('/api/debug/telegram-update', async (req, res) => {
  await fs.mkdir(path.resolve('data'), { recursive: true });
  await fs.writeFile(
    path.resolve('data', 'last-telegram-update.json'),
    `${JSON.stringify({ receivedAt: new Date().toISOString(), update: req.body }, null, 2)}\n`,
    'utf8'
  );
  res.json({ ok: true });
});

app.get('/api/debug/telegram-last', async (_req, res) => {
  try {
    const raw = await fs.readFile(path.resolve('data', 'last-telegram-update.json'), 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'No debug Telegram update stored.' });
  }
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
    allowed_updates: TELEGRAM_ALLOWED_UPDATES
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

  const { event, results, duplicate, channels } = await postBuyAlert({
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
      chartUrl: getDexScreenerChartUrl(coin.contract)
    }
  });

  res.json({
    ok: true,
    duplicate: Boolean(duplicate),
    channels,
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results
      .map((result, index) => ({ result, chatId: channels[index] }))
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

  const { event, results, duplicate, channels } = await postBuyAlert({
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
      chartUrl: getDexScreenerChartUrl(coin.contract)
    }
  });

  res.json({
    ok: true,
    duplicate: Boolean(duplicate),
    channels,
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results
      .map((result, index) => ({ result, chatId: channels[index] }))
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

  if (isSellLikeEvent(parsed.data)) {
    res.status(202).json({ ok: true, ignored: true, reason: 'sell-event' });
    return;
  }

  const coin = parsed.data.contract
    ? await getCoinByContract(parsed.data.contract)
    : await getCoin(parsed.data.symbol);

  if (!coin?.enabled) {
    res.status(404).json({ error: `Coin is not registered or is disabled.` });
    return;
  }

  const { event, results, channels } = await postBuyAlert({ coin, eventInput: parsed.data });

  res.json({
    ok: true,
    channels,
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

function startHeliusPolling() {
  const interval = Math.max(2000, Number(HELIUS_POLL_INTERVAL_MS) || 15000);
  console.log(`Helius polling enabled. Scanning tracked contracts every ${interval}ms.`);

  pollTrackedContractsOnce().catch((error) => {
    console.error('Initial Helius poll failed:', error.message);
  });

  setInterval(() => {
    pollTrackedContractsOnce().catch((error) => {
      console.error('Helius poll failed:', error.message);
    });
  }, interval);
}

async function pollTrackedContractsOnce() {
  if (!HELIUS_API_KEY) {
    console.warn('Helius polling skipped. HELIUS_API_KEY is missing.');
    return { scannedContracts: 0, accepted: 0, ignored: 0 };
  }

  const store = await readStore();
  const contracts = Array.from(new Set(
    store.coins
      .filter((coin) => coin.enabled && coin.contract && (coin.channels ?? []).length > 0)
      .map((coin) => coin.contract)
  ));

  let accepted = 0;
  let ignored = 0;

  for (const contract of contracts) {
    const transactions = await fetchRecentHeliusTransactionsForAddress(contract);
    const result = await processHeliusPayload(transactions);
    accepted += result.accepted.length;
    ignored += result.ignored.length;
  }

  if (accepted > 0 || String(DEBUG_HELIUS_NOTIFICATIONS).toLowerCase() === 'true') {
    console.log(`Helius poll scanned ${contracts.length} contracts, accepted ${accepted}, ignored ${ignored}.`);
  }

  return { scannedContracts: contracts.length, accepted, ignored };
}

async function fetchRecentHeliusTransactionsForAddress(address) {
  const url = new URL(`https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions`);
  url.searchParams.set('api-key', HELIUS_API_KEY);
  url.searchParams.set('limit', '10');

  const response = await fetch(url);
  const body = await response.json().catch(() => []);

  if (!response.ok) {
    throw new Error(`Helius address history failed for ${address}: ${body.error ?? body.message ?? response.status}`);
  }

  return Array.isArray(body) ? body : [];
}

async function startBitqueryStream() {
  if (!BITQUERY_TOKEN) {
    console.warn('Bitquery stream skipped. Set BITQUERY_TOKEN on Render.');
    return;
  }

  const contracts = await getTrackedContracts();
  if (contracts.length === 0) {
    console.warn('Bitquery stream skipped. No tracked contracts yet.');
    return;
  }

  if (bitquerySocket) {
    bitquerySocket.close();
    bitquerySocket = null;
  }

  const query = buildBitquerySolanaBuysSubscription(contracts);
  const socket = new WebSocket(`wss://streaming.bitquery.io/graphql?token=${BITQUERY_TOKEN}`, ['graphql-ws']);
  bitquerySocket = socket;

  socket.on('open', () => {
    console.log(`Connected to Bitquery stream for ${contracts.length} tracked CA(s).`);
    socket.send(JSON.stringify({ type: 'connection_init' }));
  });

  socket.on('message', async (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (response.type === 'connection_ack') {
        socket.send(JSON.stringify({
          type: 'start',
          id: 'tracked-solana-buys',
          payload: { query }
        }));
        return;
      }

      if (response.type === 'data') {
        await processBitqueryMessage(response.payload?.data);
        return;
      }

      if (response.type === 'error') {
        console.error('Bitquery stream error:', JSON.stringify(response.payload));
      }
    } catch (error) {
      console.error('Could not process Bitquery message:', error.message);
    }
  });

  socket.on('close', () => {
    console.warn('Bitquery stream disconnected. Reconnecting soon.');
    if (bitquerySocket === socket) {
      bitquerySocket = null;
      restartBitqueryStreamSoon();
    }
  });

  socket.on('error', (error) => {
    console.error('Bitquery websocket error:', error.message);
  });
}

async function getTrackedContracts() {
  const store = await readStore();
  return Array.from(new Set(
    store.coins
      .filter((coin) => coin.enabled && coin.contract && (coin.channels ?? []).length > 0)
      .map((coin) => coin.contract)
  ));
}

function buildBitquerySolanaBuysSubscription(contracts) {
  const quotedContracts = contracts.map((contract) => `"${contract}"`).join(', ');

  return `
    subscription TrackedSolanaBuys {
      Solana {
        DEXTrades(
          where: {
            Transaction: { Result: { Success: true } }
            Trade: { Buy: { Currency: { MintAddress: { in: [${quotedContracts}] } } } }
          }
        ) {
          Block { Time }
          Transaction { Signature }
          Trade {
            Dex { ProtocolName ProtocolFamily }
            Buy {
              Amount
              PriceInUSD
              Account { Address }
              Currency { MintAddress Symbol Name }
            }
            Sell {
              Amount
              Account { Address }
              Currency { MintAddress Symbol Name }
            }
          }
        }
      }
    }
  `;
}

async function processBitqueryMessage(data) {
  const trades = data?.Solana?.DEXTrades ?? [];

  for (const row of trades) {
    const buy = row.Trade?.Buy;
    const sell = row.Trade?.Sell;
    const contract = buy?.Currency?.MintAddress;
    const coin = contract ? await getCoinByContract(contract) : null;

    if (!coin?.enabled) continue;

    const tokenAmount = Number(buy.Amount ?? 0);
    if (tokenAmount <= 0) continue;

    const priceUsd = Number(buy.PriceInUSD ?? 0);
    const sellSymbol = sell?.Currency?.Symbol || DEFAULT_QUOTE_SYMBOL;
    const eventInput = {
      contract,
      buyer: buy.Account?.Address ?? sell?.Account?.Address,
      tokenAmount,
      usdValue: Number.isFinite(priceUsd) ? tokenAmount * priceUsd : 0,
      quoteAmount: Number(sell?.Amount ?? 0) || undefined,
      quoteSymbol: sellSymbol,
      dex: row.Trade?.Dex?.ProtocolName ?? row.Trade?.Dex?.ProtocolFamily ?? 'Bitquery DEX',
      txSignature: row.Transaction?.Signature,
      chartUrl: getDexScreenerChartUrl(contract),
      txUrl: row.Transaction?.Signature ? `https://solscan.io/tx/${row.Transaction.Signature}` : undefined
    };

    await postBuyAlert({ coin, eventInput });
  }
}

function restartBitqueryStreamSoon() {
  if (String(ENABLE_BITQUERY_STREAM).toLowerCase() !== 'true') return;

  clearTimeout(bitqueryRestartTimer);
  bitqueryRestartTimer = setTimeout(() => {
    startBitqueryStream().catch((error) => {
      console.error('Bitquery stream restart failed:', error.message);
    });
  }, 3000);
}

async function startPumpPortalStream() {
  const contracts = await getTrackedContracts();
  if (contracts.length === 0) {
    console.warn('PumpPortal stream skipped. No tracked contracts yet.');
    return;
  }

  if (pumpPortalSocket) {
    pumpPortalSocket.close();
    pumpPortalSocket = null;
  }

  const url = PUMPPORTAL_API_KEY
    ? `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`
    : 'wss://pumpportal.fun/api/data';
  const socket = new WebSocket(url);
  pumpPortalSocket = socket;

  socket.on('open', () => {
    console.log(`Connected to PumpPortal stream for ${contracts.length} tracked CA(s).`);
    socket.send(JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: contracts
    }));
  });

  socket.on('message', async (data) => {
    try {
      const event = JSON.parse(data.toString());
      await processPumpPortalTrade(event);
    } catch (error) {
      console.error('Could not process PumpPortal message:', error.message);
    }
  });

  socket.on('close', () => {
    console.warn('PumpPortal stream disconnected. Reconnecting soon.');
    if (pumpPortalSocket === socket) {
      pumpPortalSocket = null;
      restartPumpPortalStreamSoon();
    }
  });

  socket.on('error', (error) => {
    console.error('PumpPortal websocket error:', error.message);
  });
}

async function processPumpPortalTrade(event) {
  if (!event?.mint || String(event.txType ?? '').toLowerCase() !== 'buy') return;

  const coin = await getCoinByContract(event.mint);
  if (!coin?.enabled) return;

  await postBuyAlert({
    coin,
    eventInput: {
      contract: event.mint,
      buyer: event.traderPublicKey,
      tokenAmount: Number(event.tokenAmount ?? event.tokensBought ?? 0),
      usdValue: 0,
      quoteAmount: Number(event.solAmount ?? event.solSpent ?? 0) || undefined,
      quoteSymbol: 'SOL',
      marketCap: event.marketCapUsd,
      dex: event.pool ? `PumpPortal ${event.pool}` : 'PumpPortal',
      txSignature: event.signature,
      chartUrl: getDexScreenerChartUrl(event.mint),
      txUrl: event.signature ? `https://solscan.io/tx/${event.signature}` : undefined
    }
  });
}

function restartPumpPortalStreamSoon() {
  if (String(ENABLE_PUMPPORTAL_STREAM).toLowerCase() !== 'true') return;

  clearTimeout(pumpPortalRestartTimer);
  pumpPortalRestartTimer = setTimeout(() => {
    startPumpPortalStream().catch((error) => {
      console.error('PumpPortal stream restart failed:', error.message);
    });
  }, 3000);
}

async function startNativeSolanaWatcher() {
  const contracts = await getTrackedContracts();
  if (contracts.length === 0) {
    console.warn('Native Solana watcher skipped. No tracked contracts yet.');
    return;
  }

  await stopNativeSolanaWatcher();

  const wsUrl = SOLANA_WS_URL || SOLANA_RPC_HTTP.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  nativeSolanaConnection = new Connection(SOLANA_RPC_HTTP, {
    commitment: 'confirmed',
    wsEndpoint: wsUrl
  });

  const watchAddresses = new Map();

  for (const contract of contracts) {
    try {
      const mint = new PublicKey(contract);
      watchAddresses.set(mint.toBase58(), { contract, kind: 'mint' });
      watchAddresses.set(getPumpBondingCurvePda(mint).toBase58(), { contract, kind: 'pump-bonding-curve' });
    } catch (error) {
      console.error(`Invalid Solana mint for native watcher: ${contract}`, error.message);
    }
  }

  for (const [address, info] of watchAddresses) {
    const subscriptionId = nativeSolanaConnection.onLogs(
      new PublicKey(address),
      (logs) => handleNativeSolanaLogs(logs, info).catch((error) => {
        console.error('Native Solana log handler failed:', error.message);
      }),
      'confirmed'
    );
    nativeSolanaSubscriptionIds.push(subscriptionId);
  }

  console.log(`Native Solana watcher subscribed to ${watchAddresses.size} address(es) for ${contracts.length} tracked CA(s).`);
}

async function stopNativeSolanaWatcher() {
  if (!nativeSolanaConnection) {
    nativeSolanaSubscriptionIds = [];
    return;
  }

  await Promise.allSettled(
    nativeSolanaSubscriptionIds.map((id) => nativeSolanaConnection.removeOnLogsListener(id))
  );
  nativeSolanaSubscriptionIds = [];
}

function restartNativeSolanaWatcherSoon() {
  if (String(ENABLE_NATIVE_SOLANA_WATCHER).toLowerCase() !== 'true') return;

  setTimeout(() => {
    startNativeSolanaWatcher().catch((error) => {
      console.error('Native Solana watcher restart failed:', error.message);
    });
  }, 3000);
}

function getPumpBondingCurvePda(mint) {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return bondingCurve;
}

async function handleNativeSolanaLogs(logs, info) {
  if (logs.err || !logs.signature) return;
  if (!nativeLogsLookLikeSwap(logs.logs ?? [])) return;
  if (nativeSolanaSeenSignatures.has(logs.signature)) return;
  nativeSolanaSeenSignatures.add(logs.signature);

  if (nativeSolanaSeenSignatures.size > 5000) {
    const oldest = nativeSolanaSeenSignatures.values().next().value;
    nativeSolanaSeenSignatures.delete(oldest);
  }

  const transaction = await nativeSolanaConnection.getParsedTransaction(logs.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0
  });
  if (!transaction?.meta) return;

  const eventInput = parseNativeSolanaBuy(transaction, info.contract, logs.signature);
  if (!eventInput) return;

  const coin = await getCoinByContract(info.contract);
  if (!coin?.enabled) return;

  await postBuyAlert({ coin, eventInput });
}

function nativeLogsLookLikeSwap(logLines) {
  return logLines.some((line) => {
    const text = String(line);
    return /Instruction:\s*(Buy|Swap|SwapV2|Route)/i.test(text)
      || /\b(Pump|Raydium|Jupiter|Meteora|Orca)\b/i.test(text);
  });
}

function parseNativeSolanaBuy(transaction, contract, signature) {
  const meta = transaction.meta;
  const accountKeys = transaction.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
  const buyer = accountKeys[0];
  const tokenGain = findTokenGainForOwner(meta, contract, buyer);
  if (!tokenGain || tokenGain.amount <= 0) return null;

  const solSpent = findSolSpentByOwner(meta, accountKeys, buyer);
  if (solSpent < minBuySol) return null;

  return {
    contract,
    buyer,
    tokenAmount: tokenGain.amount,
    usdValue: 0,
    quoteAmount: solSpent,
    quoteSymbol: 'SOL',
    dex: 'Native Solana watcher',
    txSignature: signature,
    chartUrl: getDexScreenerChartUrl(contract),
    txUrl: `https://solscan.io/tx/${signature}`
  };
}

function findTokenGainForOwner(meta, contract, owner) {
  return findTokenGains(meta, contract)
    .filter((gain) => gain.owner === owner)
    .sort((a, b) => b.amount - a.amount)[0] ?? null;
}

function findLargestTokenGain(meta, contract) {
  return findTokenGains(meta, contract)
    .sort((a, b) => b.amount - a.amount)[0] ?? null;
}

function findTokenGains(meta, contract) {
  const pre = new Map((meta.preTokenBalances ?? [])
    .filter((balance) => balance.mint === contract)
    .map((balance) => [tokenBalanceKey(balance), uiTokenAmount(balance)]));

  return (meta.postTokenBalances ?? [])
    .filter((balance) => balance.mint === contract)
    .map((balance) => {
      const before = pre.get(tokenBalanceKey(balance)) ?? 0;
      return {
        owner: balance.owner,
        accountIndex: balance.accountIndex,
        amount: uiTokenAmount(balance) - before
      };
    })
    .filter((gain) => gain.amount > 0);
}

function tokenBalanceKey(balance) {
  return `${balance.accountIndex}:${balance.owner ?? ''}`;
}

function uiTokenAmount(balance) {
  return Number(balance.uiTokenAmount?.uiAmountString ?? balance.uiTokenAmount?.uiAmount ?? 0);
}

function findSolSpentByOwner(meta, accountKeys, owner) {
  const ownerIndex = accountKeys.indexOf(owner);
  const candidateIndexes = ownerIndex >= 0 ? [ownerIndex, 0] : [0];

  for (const index of candidateIndexes) {
    const pre = Number(meta.preBalances?.[index] ?? 0);
    const post = Number(meta.postBalances?.[index] ?? 0);
    const diff = pre - post;
    if (diff > 0) return diff / 1_000_000_000;
  }

  return 0;
}

function startKeepAlive() {
  const targetUrl = KEEP_ALIVE_URL || (BASE_URL ? `${BASE_URL.replace(/\/$/, '')}/health` : null);
  if (!targetUrl) {
    console.warn('Keep-alive skipped. Set BASE_URL or KEEP_ALIVE_URL.');
    return;
  }

  const interval = Math.max(60000, Number(KEEP_ALIVE_INTERVAL_MS) || 600000);
  console.log(`Keep-alive enabled. Pinging ${targetUrl} every ${interval}ms.`);

  pingKeepAlive(targetUrl);
  setInterval(() => pingKeepAlive(targetUrl), interval);
}

async function pingKeepAlive(targetUrl) {
  try {
    const response = await fetch(targetUrl);
    console.log(`Keep-alive ping ${targetUrl}: ${response.status}`);
  } catch (error) {
    console.error(`Keep-alive ping failed for ${targetUrl}:`, error.message);
  }
}

function startDexScreenerPolling() {
  const interval = Math.max(5000, Number(DEXSCREENER_POLL_INTERVAL_MS) || 20000);
  console.log(`DEX Screener polling enabled. Checking tracked contracts every ${interval}ms.`);

  pollDexScreenerOnce().catch((error) => {
    console.error('Initial DEX Screener poll failed:', error.message);
  });

  setInterval(() => {
    pollDexScreenerOnce().catch((error) => {
      console.error('DEX Screener poll failed:', error.message);
    });
  }, interval);
}

async function pollDexScreenerOnce() {
  const store = await readStore();
  const coins = store.coins.filter((coin) => coin.enabled && coin.contract && (coin.channels ?? []).length > 0);

  for (const coin of coins) {
    const pair = await getBestDexScreenerPair(coin.contract);
    if (!pair) continue;

    const stateKey = `${coin.contract}:${pair.pairAddress}`;
    const currentBuys = Number(pair.txns?.m5?.buys ?? pair.txns?.h1?.buys ?? 0);
    const currentVolume = Number(pair.volume?.m5 ?? pair.volume?.h1 ?? 0);
    const previous = dexScreenerState.get(stateKey);

    dexScreenerState.set(stateKey, {
      buys: currentBuys,
      volume: currentVolume,
      seenAt: Date.now()
    });

    if (!previous) continue;

    const buyDelta = currentBuys - previous.buys;
    if (buyDelta <= 0) continue;

    const volumeDelta = Math.max(0, currentVolume - previous.volume);
    await postBuyAlert({
      coin,
      eventInput: {
        contract: coin.contract,
        buyer: 'DEXSCREENER_AGGREGATE',
        tokenAmount: 0,
        usdValue: volumeDelta,
        aggregateBuys: buyDelta,
        aggregateVolumeUsd: volumeDelta,
        marketCap: pair.marketCap,
        dex: `${pair.dexId ?? 'dex'} aggregate`,
        txSignature: `dexscreener-${pair.pairAddress}-${currentBuys}-${Date.now()}`,
        chartUrl: pair.url
      }
    });
  }
}

async function getBestDexScreenerPair(contract) {
  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${contract}`);
    if (!response.ok) return null;

    const pairs = await response.json();
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    return pairs
      .filter((pair) => pair.pairAddress)
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0] ?? null;
  } catch (error) {
    console.error(`DEX Screener polling failed for ${contract}:`, error.message);
    return null;
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
  botId = me.id;
  console.log(`Telegram bot connected as @${me.username}`);

  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'help', description: 'Show bot commands' },
    { command: 'coins', description: 'List tracked coins' },
    { command: 'trending', description: 'Show 24h trending volume' },
    { command: 'chatid', description: 'Show this chat id' },
    { command: 'chats', description: 'Show tracked chats' },
    { command: 'backup_here', description: 'Use this chat for backups' },
    { command: 'backup_now', description: 'Post a backup now' },
    { command: 'restore_backup', description: 'Restore from replied backup' },
    { command: 'sync_helius', description: 'Sync tracked CAs to Helius' },
    { command: 'scan_now', description: 'Scan tracked CAs for recent buys' },
    { command: 'track', description: 'Track a coin in this chat' },
    { command: 'setcoin', description: 'Register this chat for a coin CA' },
    { command: 'setca', description: 'Register this chat for a coin CA' },
    { command: 'setmedia', description: 'Set custom buy alert photo/video' },
    { command: 'clearmedia', description: 'Clear custom buy alert media' },
    { command: 'setemoji', description: 'Set custom buy alert emojis' },
    { command: 'setbuyemoji', description: 'Scale emojis by SOL buy amount' },
    { command: 'buysettings', description: 'Toggle buy alert sections' },
    { command: 'autoca', description: 'Auto setup this chat from a CA' },
    { command: 'settings', description: 'Show this chat buy settings' },
    { command: 'testbuy', description: 'Send a test buy alert' },
    { command: 'addcoin', description: 'Register another coin' },
    { command: 'modsettings', description: 'Show group manager settings' },
    { command: 'rules', description: 'Show group rules' },
    { command: 'setrules', description: 'Set group rules' },
    { command: 'welcome', description: 'Toggle welcome messages' },
    { command: 'setwelcome', description: 'Set welcome message' },
    { command: 'antilinks', description: 'Toggle anti-link moderation' },
    { command: 'warn', description: 'Warn a user' },
    { command: 'warnings', description: 'Show user warnings' },
    { command: 'clearwarns', description: 'Clear user warnings' },
    { command: 'mute', description: 'Mute a user' },
    { command: 'unmute', description: 'Unmute a user' },
    { command: 'kick', description: 'Kick a user' },
    { command: 'ban', description: 'Ban a user' },
    { command: 'unban', description: 'Unban a user' },
    { command: 'clean', description: 'Delete recent messages' },
    { command: 'pin', description: 'Pin a replied message' },
    { command: 'unpin', description: 'Unpin a message' },
    { command: 'slowmode', description: 'Set group slowmode' },
    { command: 'lock', description: 'Lock group messages' },
    { command: 'unlock', description: 'Unlock group messages' },
    { command: 'save', description: 'Save a group note' },
    { command: 'get', description: 'Show a group note' },
    { command: 'notes', description: 'List saved notes' },
    { command: 'delnote', description: 'Delete a group note' },
    { command: 'filter', description: 'Add an auto reply filter' },
    { command: 'filters', description: 'List auto reply filters' },
    { command: 'stopfilter', description: 'Delete an auto reply filter' }
  ]);

  recoverKnownChatTracking().catch((error) => {
    console.error('Known chat recovery failed:', error.message);
  });

  if (telegramWebhookUrl) {
    await bot.telegram.setWebhook(telegramWebhookUrl, {
      drop_pending_updates: true,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES
    });
    console.log(`Telegram webhook set to ${telegramWebhookUrl}`);
  } else {
    await bot.telegram.deleteWebhook({
      drop_pending_updates: true
    });
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: TELEGRAM_ALLOWED_UPDATES
    });
    console.log('Telegram polling started. Leave this window open.');
  }

  if (String(ENABLE_HELIUS_POLLING).toLowerCase() === 'true') {
    startHeliusPolling();
  }

  if (String(ENABLE_BITQUERY_STREAM).toLowerCase() === 'true') {
    startBitqueryStream().catch((error) => {
      console.error('Bitquery stream failed to start:', error.message);
    });
  }

  if (String(ENABLE_PUMPPORTAL_STREAM).toLowerCase() === 'true') {
    startPumpPortalStream().catch((error) => {
      console.error('PumpPortal stream failed to start:', error.message);
    });
  }

  if (String(ENABLE_NATIVE_SOLANA_WATCHER).toLowerCase() === 'true') {
    startNativeSolanaWatcher().catch((error) => {
      console.error('Native Solana watcher failed to start:', error.message);
    });
  }

  if (String(ENABLE_DEXSCREENER_POLLING).toLowerCase() === 'true') {
    startDexScreenerPolling();
  }

  if (String(ENABLE_KEEP_ALIVE).toLowerCase() === 'true') {
    startKeepAlive();
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
    ?? ctx.editedMessage?.text
    ?? ctx.editedMessage?.caption
    ?? ctx.channelPost?.text
    ?? ctx.channelPost?.caption
    ?? ctx.editedChannelPost?.text
    ?? ctx.editedChannelPost?.caption
    ?? '';
}

function getUpdateMessage(ctx) {
  return ctx.message
    ?? ctx.channelPost
    ?? ctx.editedMessage
    ?? ctx.editedChannelPost
    ?? null;
}

function getUpdateTextWithReply(ctx) {
  const message = ctx.message
    ?? ctx.channelPost
    ?? ctx.editedMessage
    ?? ctx.editedChannelPost;
  const replyText = getReplyText(ctx);

  return [getUpdateText(ctx), replyText].filter(Boolean).join('\n');
}

function getReplyText(ctx) {
  const message = getUpdateMessage(ctx);
  return message?.reply_to_message?.text
    ?? message?.reply_to_message?.caption
    ?? '';
}

async function handleFallbackCommand(ctx) {
  await rememberChat(ctx.chat);
  if (await handlePendingSettingsReply(ctx)) return;
  if (await handleWelcomeEvent(ctx)) return;

  const parsed = parseCommandFromText(getUpdateText(ctx));
  if (!parsed) {
    await autoTrackContractFromChat(ctx);
    if (await handleAntiLinkModeration(ctx)) return;
    await handleAutoFilterReplies(ctx);
    return;
  }

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

  if (command === 'backup_here') {
    telegramBackupChatId = String(ctx.chat.id);
    await sendTelegramBackup('Backup channel set from /backup_here.');
    await ctx.reply('This chat is now the Telegram backup channel. Backups will post here after setup changes.');
    return;
  }

  if (command === 'backup_now') {
    if (!telegramBackupChatId) telegramBackupChatId = String(ctx.chat.id);
    await sendTelegramBackup('Manual backup from /backup_now.');
    await ctx.reply('Backup posted.');
    return;
  }

  if (command === 'restore_backup') {
    const restored = await restoreTelegramBackupFromReply(ctx);
    if (restored) {
      await ctx.reply(`Restored backup: ${restored.coins.length} coins, ${restored.events.length} events, ${Object.keys(restored.groupSettings ?? {}).length} group settings.`);
      restartBitqueryStreamSoon();
      restartPumpPortalStreamSoon();
      restartNativeSolanaWatcherSoon();
    }
    return;
  }

  if (command === 'setcoin' || command === 'setca') {
    await setCoinForChat(ctx, args);
    return;
  }

  if (command === 'setmedia') {
    await setMediaForChat(ctx, args);
    return;
  }

  if (command === 'clearmedia') {
    await clearMediaForChat(ctx, args);
    return;
  }

  if (command === 'setemoji') {
    await setEmojiForChat(ctx, args);
    return;
  }

  if (command === 'setbuyemoji') {
    await setBuyEmojiForChat(ctx, args);
    return;
  }

  if (command === 'buysettings') {
    await setBuySettingsForChat(ctx, args);
    return;
  }

  if (command === 'autoca') {
    await autoTrackContractFromChat(ctx, { force: true, notifyNoContract: true });
    return;
  }

  if (command === 'settings') {
    await replyWithBuySettings(ctx);
    return;
  }

  if (command === 'track') {
    await trackSymbolForChat(ctx, args[0]);
    return;
  }

  if (command === 'testbuy') {
    await sendTestBuy(ctx, args[0] ?? 'OGRE');
    return;
  }

  if (command === 'modsettings') {
    await replyWithModSettings(ctx);
    return;
  }

  if (command === 'rules') {
    await replyWithRules(ctx);
    return;
  }

  if (command === 'setrules') {
    await setRulesForChat(ctx, args.join(' '));
    return;
  }

  if (command === 'welcome') {
    await setWelcomeToggle(ctx, args[0]);
    return;
  }

  if (command === 'setwelcome') {
    await setWelcomeText(ctx, args.join(' '));
    return;
  }

  if (command === 'antilinks') {
    await setAntiLinksToggle(ctx, args[0]);
    return;
  }

  if (command === 'warn') {
    await warnUser(ctx, args, { source: 'command' });
    return;
  }

  if (command === 'warnings') {
    await replyWithWarnings(ctx, args);
    return;
  }

  if (command === 'clearwarns') {
    await clearUserWarnings(ctx, args);
    return;
  }

  if (command === 'mute') {
    await muteUser(ctx, args);
    return;
  }

  if (command === 'unmute') {
    await unmuteUser(ctx, args);
    return;
  }

  if (command === 'kick') {
    await kickUser(ctx, args);
    return;
  }

  if (command === 'ban') {
    await banUser(ctx, args);
    return;
  }

  if (command === 'unban') {
    await unbanUser(ctx, args);
    return;
  }

  if (command === 'clean') {
    await cleanRecentMessages(ctx, args);
    return;
  }

  if (command === 'pin') {
    await pinRepliedMessage(ctx);
    return;
  }

  if (command === 'unpin') {
    await unpinMessage(ctx);
    return;
  }

  if (command === 'slowmode') {
    await setSlowMode(ctx, args);
    return;
  }

  if (command === 'lock') {
    await lockChat(ctx);
    return;
  }

  if (command === 'unlock') {
    await unlockChat(ctx);
    return;
  }

  if (command === 'save') {
    await saveNote(ctx, args);
    return;
  }

  if (command === 'get') {
    await getNote(ctx, args);
    return;
  }

  if (command === 'notes') {
    await listNotes(ctx);
    return;
  }

  if (command === 'delnote') {
    await deleteNote(ctx, args);
    return;
  }

  if (command === 'filter') {
    await saveFilter(ctx, args);
    return;
  }

  if (command === 'filters') {
    await listFilters(ctx);
    return;
  }

  if (command === 'stopfilter') {
    await deleteFilter(ctx, args);
    return;
  }

  await handleAntiLinkModeration(ctx);
}

function parseCommandFromText(rawText) {
  let text = rawText.trim();
  if (!text) return null;

  const mentionPattern = botUsername ? new RegExp(`^@${escapeRegExp(botUsername)}\\b\\s*`, 'i') : /^@\w+\b\s*/i;
  text = text.replace(mentionPattern, '').trim();

  if (!text.startsWith('/')) {
    const firstWord = text.split(/\s+/)[0]?.toLowerCase();
    const mentionOnlyCommands = new Set([
      'help', 'start', 'chatid', 'chats', 'setcoin', 'setca', 'setmedia', 'clearmedia',
      'setemoji', 'setbuyemoji', 'buysettings', 'autoca', 'settings', 'track', 'testbuy',
      'modsettings', 'rules', 'setrules', 'welcome', 'setwelcome', 'antilinks', 'warn',
      'warnings', 'clearwarns', 'mute', 'unmute', 'kick', 'ban', 'unban', 'clean', 'pin',
      'unpin', 'slowmode', 'lock', 'unlock', 'save', 'get', 'notes', 'delnote',
      'filter', 'filters', 'stopfilter'
    ]);
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

  const tokenMeta = await getTokenMetadata(contract);
  const buyUrl = buyUrlArg || `https://pump.fun/coin/${contract}`;
  const coin = await addChannelToCoinByContract(contract, ctx.chat.id, {
    symbol,
    name: tokenMeta?.name || symbol.toUpperCase(),
    buyUrl,
    website: tokenMeta?.website || buyUrl,
    imageUrl: tokenMeta?.imageUrl,
    twitter: tokenMeta?.twitter,
    telegram: tokenMeta?.telegram
  });
  const heliusResult = await ensureHeliusTracksContract(coin.contract);
  restartBitqueryStreamSoon();
  restartPumpPortalStreamSoon();
  restartNativeSolanaWatcherSoon();

  await ctx.reply([
    `This chat is now tracking $${coin.symbol} buys for ${coin.contract}.`,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
  await sendTelegramBackup(`Set ${coin.symbol} ${coin.contract} for chat ${ctx.chat.id}.`);
}

async function setMediaForChat(ctx, args) {
  const { target, mediaUrl } = parseOptionalTargetAndValue(ctx, args);
  const media = getAttachedMedia(ctx) ?? (mediaUrl ? mediaFromUrl(mediaUrl) : null);

  if (!media) {
    await ctx.reply('Reply to a photo/video with /setmedia SYMBOL, or use /setmedia SYMBOL https://media-url');
    return;
  }

  const coin = await updateCoinChatSettings(ctx.chat.id, target, { media });
  await ctx.reply(`Custom ${media.type} set for $${coin.symbol} buy alerts in this chat.`);
  await sendTelegramBackup(`Set custom media for $${coin.symbol} in chat ${ctx.chat.id}.`);
}

async function clearMediaForChat(ctx, args) {
  const [target] = args;
  const coin = await updateCoinChatSettings(ctx.chat.id, target, { media: null });
  await ctx.reply(`Custom media cleared for $${coin.symbol}. Token metadata image will be used again.`);
  await sendTelegramBackup(`Cleared custom media for $${coin.symbol} in chat ${ctx.chat.id}.`);
}

async function setEmojiForChat(ctx, args) {
  const { target, value } = await parseOptionalCoinTarget(ctx.chat.id, args);
  const emojiLine = value.trim();

  if (!emojiLine) {
    await ctx.reply('Usage: /setemoji SYMBOL 🧌 🟢 🧪 🫧 🧌');
    return;
  }

  const coin = await updateCoinChatSettings(ctx.chat.id, target, { emojiLine });
  await ctx.reply(`Custom emojis set for $${coin.symbol} buy alerts in this chat.`);
  await sendTelegramBackup(`Set custom emojis for $${coin.symbol} in chat ${ctx.chat.id}.`);
}

async function setBuyEmojiForChat(ctx, args) {
  const { target, value } = await parseOptionalCoinTarget(ctx.chat.id, args);
  const parsed = parseBuyEmojiValue(value);

  if (!parsed) {
    await ctx.reply('Usage: /setbuyemoji SYMBOL 0.25 🧌🧌🧌');
    return;
  }

  const coin = await updateCoinChatSettings(ctx.chat.id, target, { buyEmoji: parsed });
  await ctx.reply(`Buy emoji scaling set for $${coin.symbol}: one line every ${parsed.baseSol} SOL.`);
  await sendTelegramBackup(`Set buy emoji scaling for $${coin.symbol} in chat ${ctx.chat.id}.`);
}

async function setBuySettingsForChat(ctx, args) {
  const { target, key, enabled } = await parseBuySettingsArgs(ctx.chat.id, args);

  if (!key || enabled == null) {
    await ctx.reply('Usage: /buysettings SYMBOL topmovers|footer|bonding|socials on|off');
    return;
  }

  const settingKey = {
    topmovers: 'showTopMovers',
    footer: 'showFooter',
    bonding: 'showBonding',
    socials: 'showSocials'
  }[key];

  if (!settingKey) {
    await ctx.reply('Setting must be one of: topmovers, footer, bonding, socials.');
    return;
  }

  const coin = await updateCoinChatSettings(ctx.chat.id, target, { [settingKey]: enabled });
  await ctx.reply(`$${coin.symbol} ${key} is now ${enabled ? 'on' : 'off'} in this chat.`);
  await sendTelegramBackup(`Set ${key} ${enabled ? 'on' : 'off'} for $${coin.symbol} in chat ${ctx.chat.id}.`);
}

async function replyWithBuySettings(ctx) {
  const coins = await getCoinsByChat(ctx.chat.id);
  if (coins.length === 0) {
    await ctx.reply(...renderEmptySettingsMenu());
    return;
  }

  await ctx.reply(...renderSettingsMenu(ctx.chat.id, coins));
}

async function handleSettingsCallback(ctx) {
  const data = ctx.callbackQuery?.data ?? '';

  if (data.startsWith('mod:')) {
    await handleModSettingsCallback(ctx);
    return;
  }

  if (!data.startsWith('settings:')) {
    await ctx.answerCbQuery().catch(() => {});
    return;
  }

  const [, action, symbol, key] = data.split(':');
  const chatId = ctx.callbackQuery.message?.chat?.id;

  if (!chatId) {
    await ctx.answerCbQuery('Could not find this chat.').catch(() => {});
    return;
  }

  if (action === 'help') {
    const helpText = {
      media: 'Reply to a photo/video with /setmedia SYMBOL, or send /setmedia SYMBOL https://media-url',
      emoji: 'Use /setemoji SYMBOL followed by the emojis you want on the alert.',
      scale: 'Use /setbuyemoji SYMBOL 0.25 emojis. Example: /setbuyemoji OGRE 0.25 🧌🧌🧌',
      autoca: 'Paste a Pump.fun link or CA in this chat, or reply to it with /autoca.',
      setcoin: 'Use /setcoin SYMBOL CONTRACT. Example: /setcoin OGRE 5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump'
    }[symbol] ?? 'Use the buttons or commands shown in /settings.';
    await ctx.answerCbQuery(helpText, { show_alert: true }).catch(() => {});
    return;
  }

  if (action === 'prompt') {
    const coins = await getCoinsByChat(chatId);
    const coin = coins.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
    if (!coin) {
      await ctx.answerCbQuery('This coin is no longer tracked in this chat.').catch(() => {});
      return;
    }

    setPendingSetting(chatId, ctx.from?.id, {
      action: key,
      symbol: coin.symbol,
      contract: coin.contract
    });

    const promptText = {
      media: `Reply here with the image, GIF, video, or media URL to use for $${coin.symbol} buy alerts.`,
      emoji: `Reply here with the emojis to use around $${coin.symbol} buy alerts.`,
      scale: `Reply here with the SOL base and emoji line for $${coin.symbol}. Example: 0.25 🧌🧌🧌`
    }[key] ?? `Reply here with the setting for $${coin.symbol}.`;

    await ctx.reply(promptText, {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });
    await ctx.answerCbQuery('Reply to the prompt I just sent.').catch(() => {});
    return;
  }

  if (action === 'toggle') {
    const coins = await getCoinsByChat(chatId);
    const coin = coins.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());

    if (!coin) {
      await ctx.answerCbQuery('This coin is no longer tracked in this chat.').catch(() => {});
      return;
    }

    const settingKey = getSettingKey(key);
    if (!settingKey) {
      await ctx.answerCbQuery('Unknown setting.').catch(() => {});
      return;
    }

    const current = getChatSettings(coin, chatId)[settingKey] !== false;
    await updateCoinChatSettings(chatId, coin.symbol, { [settingKey]: !current });
    const updatedCoins = await getCoinsByChat(chatId);
    await ctx.editMessageText(...renderSettingsMenu(chatId, updatedCoins)).catch(async () => {
      await ctx.reply(...renderSettingsMenu(chatId, updatedCoins));
    });
    await ctx.answerCbQuery(`${coin.symbol} ${key} ${!current ? 'on' : 'off'}`).catch(() => {});
    await sendTelegramBackup(`Toggled ${key} ${!current ? 'on' : 'off'} for $${coin.symbol} in chat ${chatId}.`);
    return;
  }

  await ctx.answerCbQuery().catch(() => {});
}

async function replyWithModSettings(ctx) {
  if (!await ensureGroupAdmin(ctx)) return;

  const settings = await getGroupSettings(ctx.chat.id);
  await ctx.reply(...renderModSettingsMenu(settings, 'home'));
}

function renderModSettingsMenu(settings, page = 'home', notice = '') {
  const pages = {
    home: renderModHome,
    protection: renderModProtection,
    welcome: renderModWelcome,
    content: renderModContent,
    filters: renderModFilters,
    tools: renderModTools,
    help: renderModHelp
  };
  const renderPage = pages[page] ?? pages.home;
  const [message, keyboard] = renderPage(settings, notice);

  return [
    message,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(keyboard)
    }
  ];
}

async function handleModSettingsCallback(ctx) {
  const data = ctx.callbackQuery?.data ?? '';
  const [, action, key, value] = data.split(':');
  const chatId = ctx.callbackQuery?.message?.chat?.id;

  if (!chatId) {
    await ctx.answerCbQuery('Could not find this chat.').catch(() => {});
    return;
  }

  if (!await ensureCallbackAdmin(ctx, chatId)) return;

  if (action === 'page') {
    const settings = await getGroupSettings(chatId);
    await editModPanel(ctx, settings, key || 'home');
    return;
  }

  if (action === 'toggle') {
    const current = await getGroupSettings(chatId);
    let next;
    let page = 'home';

    if (key === 'welcome') {
      next = await updateGroupSettings(chatId, {
        welcome: { enabled: !current.welcome.enabled }
      });
      page = 'welcome';
    } else if (key === 'antilinks') {
      next = await updateGroupSettings(chatId, {
        antiLinks: { enabled: !current.antiLinks.enabled }
      });
      page = 'protection';
    } else {
      await ctx.answerCbQuery('Unknown setting.').catch(() => {});
      return;
    }

    await editModPanel(ctx, next, page, `${key} ${key === 'welcome'
      ? next.welcome.enabled ? 'enabled' : 'disabled'
      : next.antiLinks.enabled ? 'enabled' : 'disabled'}.`);
    await sendTelegramBackup(`Updated group manager ${key} for chat ${chatId}.`);
    return;
  }

  if (action === 'warnlimit') {
    const current = await getGroupSettings(chatId);
    const delta = value === 'down' ? -1 : 1;
    const maxWarnings = Math.min(10, Math.max(1, Number(current.maxWarnings ?? 3) + delta));
    const next = await updateGroupSettings(chatId, { maxWarnings });
    await editModPanel(ctx, next, 'protection', `Warn limit set to ${maxWarnings}.`);
    await sendTelegramBackup(`Set warn limit to ${maxWarnings} for chat ${chatId}.`);
    return;
  }

  if (action === 'tool') {
    const settings = await getGroupSettings(chatId);

    try {
      if (key === 'lock') {
        await bot.telegram.setChatPermissions(chatId, { can_send_messages: false });
        await editModPanel(ctx, settings, 'tools', 'Chat locked.');
        return;
      }

      if (key === 'unlock') {
        await bot.telegram.setChatPermissions(chatId, openChatPermissions());
        await editModPanel(ctx, settings, 'tools', 'Chat unlocked.');
        return;
      }

      if (key === 'slowmode') {
        const delay = Math.min(Math.max(Number(value) || 0, 0), 3600);
        await bot.telegram.callApi('setChatSlowModeDelay', {
          chat_id: chatId,
          slow_mode_delay: delay
        });
        await editModPanel(ctx, settings, 'tools', delay ? `Slowmode set to ${delay}s.` : 'Slowmode turned off.');
        return;
      }
    } catch (error) {
      console.error(`Mod tool action failed in ${chatId}:`, error.message);
      await editModPanel(ctx, settings, 'tools', 'Action failed. Check my admin permissions.');
      return;
    }
  }

  await ctx.answerCbQuery().catch(() => {});
}

async function editModPanel(ctx, settings, page, notice = '') {
  await ctx.editMessageText(...renderModSettingsMenu(settings, page, notice)).catch(async () => {
    await ctx.reply(...renderModSettingsMenu(settings, page, notice));
  });
  await ctx.answerCbQuery(notice || 'Updated').catch(() => {});
}

function renderModHome(settings, notice) {
  return [
    [
      '<b>Group Manager</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      `Welcome: <b>${settings.welcome.enabled ? 'ON' : 'OFF'}</b>`,
      `Anti-links: <b>${settings.antiLinks.enabled ? 'ON' : 'OFF'}</b>`,
      `Warn limit: <b>${settings.maxWarnings}</b>`,
      `Rules: <b>${settings.rules ? 'SET' : 'EMPTY'}</b>`,
      `Notes: <b>${Object.keys(settings.notes ?? {}).length}</b>`,
      `Filters: <b>${Object.keys(settings.filters ?? {}).length}</b>`,
      '',
      'Pick a section. This panel edits in place.'
    ].filter(Boolean).join('\n'),
    [
      [
        Markup.button.callback('Protection', modCallback('page', 'protection')),
        Markup.button.callback('Welcome', modCallback('page', 'welcome'))
      ],
      [
        Markup.button.callback('Rules & Notes', modCallback('page', 'content')),
        Markup.button.callback('Filters', modCallback('page', 'filters'))
      ],
      [
        Markup.button.callback('Chat Tools', modCallback('page', 'tools')),
        Markup.button.callback('Help', modCallback('page', 'help'))
      ]
    ]
  ];
}

function renderModProtection(settings, notice) {
  return [
    [
      '<b>Protection</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      `Anti-links: <b>${settings.antiLinks.enabled ? 'ON' : 'OFF'}</b>`,
      `Auto-warn links: <b>${settings.antiLinks.warn ? 'ON' : 'OFF'}</b>`,
      `Warn limit: <b>${settings.maxWarnings}</b>`,
      '',
      'Commands: reply with /warn, /mute, /ban, /clearwarns.'
    ].filter(Boolean).join('\n'),
    [
      [Markup.button.callback(`${settings.antiLinks.enabled ? 'Disable' : 'Enable'} Anti-links`, modCallback('toggle', 'antilinks'))],
      [
        Markup.button.callback('- Warn Limit', modCallback('warnlimit', 'max', 'down')),
        Markup.button.callback('+ Warn Limit', modCallback('warnlimit', 'max', 'up'))
      ],
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

function renderModWelcome(settings, notice) {
  return [
    [
      '<b>Welcome</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      `Status: <b>${settings.welcome.enabled ? 'ON' : 'OFF'}</b>`,
      '',
      '<b>Preview</b>',
      escapeHtmlForTelegram(settings.welcome.text),
      '',
      'Edit with: /setwelcome Welcome {user} to {chat}!'
    ].filter(Boolean).join('\n'),
    [
      [Markup.button.callback(`${settings.welcome.enabled ? 'Disable' : 'Enable'} Welcome`, modCallback('toggle', 'welcome'))],
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

function renderModContent(settings, notice) {
  const noteNames = Object.keys(settings.notes ?? {});
  const notes = noteNames.length ? noteNames.map((name) => `- ${name}`).join('\n') : 'No notes saved.';
  const rules = settings.rules
    ? escapeHtmlForTelegram(settings.rules).slice(0, 900)
    : 'No rules set.';

  return [
    [
      '<b>Rules & Notes</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      '<b>Rules</b>',
      rules,
      '',
      '<b>Notes</b>',
      notes,
      '',
      'Commands: /setrules, /save name text, /get name, /delnote name.'
    ].filter(Boolean).join('\n'),
    [
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

function renderModFilters(settings, notice) {
  const triggers = Object.keys(settings.filters ?? {});
  const filters = triggers.length ? triggers.map((name) => `- ${escapeHtmlForTelegram(name)}`).join('\n') : 'No filters saved.';

  return [
    [
      '<b>Auto Replies</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      filters,
      '',
      'Commands: /filter trigger reply, /stopfilter trigger.'
    ].filter(Boolean).join('\n'),
    [
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

function renderModTools(_settings, notice) {
  return [
    [
      '<b>Chat Tools</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      'Quick controls:',
      'Lock/unlock chat and set slowmode here.',
      '',
      'Reply tools: /pin, /unpin, /clean 20.'
    ].filter(Boolean).join('\n'),
    [
      [
        Markup.button.callback('Lock Chat', modCallback('tool', 'lock')),
        Markup.button.callback('Unlock Chat', modCallback('tool', 'unlock'))
      ],
      [
        Markup.button.callback('Slow Off', modCallback('tool', 'slowmode', '0')),
        Markup.button.callback('10s', modCallback('tool', 'slowmode', '10')),
        Markup.button.callback('30s', modCallback('tool', 'slowmode', '30')),
        Markup.button.callback('60s', modCallback('tool', 'slowmode', '60'))
      ],
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

function renderModHelp(_settings, notice) {
  return [
    [
      '<b>Group Manager Help</b>',
      notice ? `<i>${escapeHtmlForTelegram(notice)}</i>` : null,
      '',
      'Most setup can be changed from buttons.',
      '',
      'Text setup still uses commands:',
      '/setrules rules text',
      '/setwelcome Welcome {user}',
      '/save name text',
      '/filter word reply',
      '',
      'Reply-based actions:',
      '/warn reason, /mute 60, /ban, /pin, /clean 20.'
    ].filter(Boolean).join('\n'),
    [
      [Markup.button.callback('Back', modCallback('page', 'home'))]
    ]
  ];
}

async function replyWithRules(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Rules work inside groups and supergroups.');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  await ctx.reply(settings.rules || 'No rules are set yet.');
}

async function setRulesForChat(ctx, rulesText) {
  if (!await ensureGroupAdmin(ctx)) return;

  const rules = String(rulesText ?? '').trim();
  if (!rules) {
    await ctx.reply('Usage: /setrules rules text');
    return;
  }

  await updateGroupSettings(ctx.chat.id, { rules: rules.slice(0, 3500) });
  await ctx.reply('Group rules updated.');
  await sendTelegramBackup(`Updated rules for chat ${ctx.chat.id}.`);
}

async function setWelcomeToggle(ctx, rawValue) {
  if (!await ensureGroupAdmin(ctx)) return;

  const enabled = parseToggleValue(rawValue);
  if (enabled == null) {
    await ctx.reply('Usage: /welcome on or /welcome off');
    return;
  }

  await updateGroupSettings(ctx.chat.id, { welcome: { enabled } });
  await ctx.reply(`Welcome messages are now ${enabled ? 'on' : 'off'}.`);
  await sendTelegramBackup(`Set welcome ${enabled ? 'on' : 'off'} for chat ${ctx.chat.id}.`);
}

async function setWelcomeText(ctx, welcomeText) {
  if (!await ensureGroupAdmin(ctx)) return;

  const text = String(welcomeText ?? '').trim();
  if (!text) {
    await ctx.reply('Usage: /setwelcome Welcome {user} to {chat}!');
    return;
  }

  await updateGroupSettings(ctx.chat.id, {
    welcome: {
      enabled: true,
      text: text.slice(0, 1000)
    }
  });
  await ctx.reply('Welcome message updated and enabled.');
  await sendTelegramBackup(`Updated welcome text for chat ${ctx.chat.id}.`);
}

async function setAntiLinksToggle(ctx, rawValue) {
  if (!await ensureGroupAdmin(ctx)) return;

  const enabled = parseToggleValue(rawValue);
  if (enabled == null) {
    await ctx.reply('Usage: /antilinks on or /antilinks off');
    return;
  }

  await updateGroupSettings(ctx.chat.id, { antiLinks: { enabled } });
  await ctx.reply(`Anti-links are now ${enabled ? 'on' : 'off'}.`);
  await sendTelegramBackup(`Set anti-links ${enabled ? 'on' : 'off'} for chat ${ctx.chat.id}.`);
}

async function handleWelcomeEvent(ctx) {
  const message = getUpdateMessage(ctx);
  const members = message?.new_chat_members;
  if (!isGroupChat(ctx) || !Array.isArray(members) || members.length === 0) return false;

  const settings = await getGroupSettings(ctx.chat.id);
  if (!settings.welcome.enabled) return false;

  for (const member of members) {
    if (member.is_bot && member.id === botId) continue;

    const welcome = renderWelcomeText(settings.welcome.text, member, ctx.chat);
    await ctx.reply(welcome, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }).catch((error) => {
      console.error(`Could not send welcome in chat ${ctx.chat.id}:`, error.message);
    });
  }

  return true;
}

async function handleAntiLinkModeration(ctx) {
  if (!isGroupChat(ctx) || !ctx.from?.id) return false;

  const text = getUpdateText(ctx);
  if (!containsExternalLink(text)) return false;

  const settings = await getGroupSettings(ctx.chat.id);
  if (!settings.antiLinks.enabled) return false;

  if (await isUserAdminInChat(ctx.chat.id, ctx.from.id)) return false;

  const message = getUpdateMessage(ctx);
  if (message?.message_id) {
    await bot.telegram.deleteMessage(ctx.chat.id, message.message_id).catch((error) => {
      console.error(`Could not delete anti-link message in ${ctx.chat.id}:`, error.message);
    });
  }

  if (settings.antiLinks.warn) {
    await recordWarningAndMaybeMute(ctx, {
      userId: ctx.from.id,
      user: ctx.from,
      reason: 'Posted a link'
    });
  }

  return true;
}

async function warnUser(ctx, args, options = {}) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args, {
    defaultReason: options.source === 'antilink' ? 'Posted a link' : 'No reason given'
  });

  if (!target) {
    await ctx.reply('Reply to a user with /warn reason, or use /warn user_id reason.');
    return;
  }

  if (!await canModerateTarget(ctx, target.userId)) return;

  await recordWarningAndMaybeMute(ctx, target);
}

async function recordWarningAndMaybeMute(ctx, target) {
  const settings = await getGroupSettings(ctx.chat.id);
  const warnings = await addWarning(ctx.chat.id, target.userId, {
    reason: target.reason || 'No reason given',
    moderatorId: ctx.from?.id ? String(ctx.from.id) : 'bot'
  });
  const count = warnings.length;
  const label = target.user ? formatUserLabel(target.user) : `user ${target.userId}`;

  if (count >= settings.maxWarnings) {
    try {
      await restrictMember(ctx.chat.id, target.userId, 60);
      await clearWarnings(ctx.chat.id, target.userId);
      await ctx.reply(`${label} reached ${settings.maxWarnings} warnings and was muted for 60 minutes.`);
    } catch (error) {
      await ctx.reply(`Warning ${count}/${settings.maxWarnings} for ${label}: ${target.reason}\nCould not mute them. Make sure the bot has ban/restrict admin rights.`);
      console.error(`Could not auto-mute ${target.userId} in ${ctx.chat.id}:`, error.message);
    }
    return;
  }

  await ctx.reply(`Warning ${count}/${settings.maxWarnings} for ${label}: ${target.reason}`);
}

async function replyWithWarnings(ctx, args) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Warnings work inside groups and supergroups.');
    return;
  }

  const target = getModerationTarget(ctx, args, { allowSelf: true });
  if (!target) {
    await ctx.reply('Reply to a user with /warnings, or use /warnings user_id.');
    return;
  }

  if (target.userId !== ctx.from?.id && !await isUserAdminInChat(ctx.chat.id, ctx.from?.id)) {
    await ctx.reply('Only admins can view another user\'s warnings.');
    return;
  }

  const warnings = await getWarnings(ctx.chat.id, target.userId);
  const label = target.user ? formatUserLabel(target.user) : `user ${target.userId}`;
  if (warnings.length === 0) {
    await ctx.reply(`${label} has no warnings.`);
    return;
  }

  await ctx.reply([
    `${label} has ${warnings.length} warning(s):`,
    ...warnings.map((warning, index) => `${index + 1}. ${warning.reason || 'No reason'} (${warning.createdAt})`)
  ].join('\n'));
}

async function clearUserWarnings(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Reply to a user with /clearwarns, or use /clearwarns user_id.');
    return;
  }

  const count = await clearWarnings(ctx.chat.id, target.userId);
  const label = target.user ? formatUserLabel(target.user) : `user ${target.userId}`;
  await ctx.reply(`Cleared ${count} warning(s) for ${label}.`);
}

async function muteUser(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Reply to a user with /mute 60, or use /mute user_id 60.');
    return;
  }

  if (!await canModerateTarget(ctx, target.userId)) return;

  const minutes = parseDurationMinutes(target.rest[0], 60);
  try {
    await restrictMember(ctx.chat.id, target.userId, minutes);
    await ctx.reply(`${target.user ? formatUserLabel(target.user) : `user ${target.userId}`} muted for ${minutes} minute(s).`);
  } catch (error) {
    await ctx.reply('Could not mute that user. Make sure the bot has ban/restrict admin rights.');
    console.error(`Could not mute ${target.userId} in ${ctx.chat.id}:`, error.message);
  }
}

async function unmuteUser(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Reply to a user with /unmute, or use /unmute user_id.');
    return;
  }

  try {
    await bot.telegram.restrictChatMember(ctx.chat.id, target.userId, {
      permissions: openChatPermissions()
    });
    await ctx.reply(`${target.user ? formatUserLabel(target.user) : `user ${target.userId}`} unmuted.`);
  } catch (error) {
    await ctx.reply('Could not unmute that user. Make sure the bot has restrict admin rights.');
    console.error(`Could not unmute ${target.userId} in ${ctx.chat.id}:`, error.message);
  }
}

async function kickUser(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Reply to a user with /kick, or use /kick user_id.');
    return;
  }

  if (!await canModerateTarget(ctx, target.userId)) return;

  try {
    const untilDate = Math.floor(Date.now() / 1000) + 60;
    await bot.telegram.banChatMember(ctx.chat.id, target.userId, untilDate);
    await bot.telegram.unbanChatMember(ctx.chat.id, target.userId, { only_if_banned: true }).catch(() => {});
    await ctx.reply(`${target.user ? formatUserLabel(target.user) : `user ${target.userId}`} kicked.`);
  } catch (error) {
    await ctx.reply('Could not kick that user. Make sure the bot has ban admin rights.');
    console.error(`Could not kick ${target.userId} in ${ctx.chat.id}:`, error.message);
  }
}

async function banUser(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Reply to a user with /ban, or use /ban user_id.');
    return;
  }

  if (!await canModerateTarget(ctx, target.userId)) return;

  try {
    await bot.telegram.banChatMember(ctx.chat.id, target.userId);
    await ctx.reply(`${target.user ? formatUserLabel(target.user) : `user ${target.userId}`} banned.`);
  } catch (error) {
    await ctx.reply('Could not ban that user. Make sure the bot has ban admin rights.');
    console.error(`Could not ban ${target.userId} in ${ctx.chat.id}:`, error.message);
  }
}

async function unbanUser(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const target = getModerationTarget(ctx, args);
  if (!target) {
    await ctx.reply('Use /unban user_id.');
    return;
  }

  try {
    await bot.telegram.unbanChatMember(ctx.chat.id, target.userId, { only_if_banned: true });
    await ctx.reply(`user ${target.userId} unbanned.`);
  } catch (error) {
    await ctx.reply('Could not unban that user. Make sure the bot has ban admin rights.');
    console.error(`Could not unban ${target.userId} in ${ctx.chat.id}:`, error.message);
  }
}

async function cleanRecentMessages(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const message = getUpdateMessage(ctx);
  const count = Math.min(Math.max(Number(args[0]) || 10, 1), 100);
  const startId = message?.message_id;
  if (!startId) {
    await ctx.reply('I could not find the message id to clean from.');
    return;
  }

  let deleted = 0;
  for (let messageId = startId; messageId > startId - count - 1; messageId -= 1) {
    const ok = await bot.telegram.deleteMessage(ctx.chat.id, messageId)
      .then(() => true)
      .catch(() => false);
    if (ok) deleted += 1;
  }

  if (deleted === 0) {
    await ctx.reply('I could not delete those messages. Make sure I have delete message admin rights.');
  }
}

async function pinRepliedMessage(ctx) {
  if (!await ensureGroupAdmin(ctx)) return;

  const reply = getUpdateMessage(ctx)?.reply_to_message;
  if (!reply?.message_id) {
    await ctx.reply('Reply to a message with /pin.');
    return;
  }

  try {
    await bot.telegram.pinChatMessage(ctx.chat.id, reply.message_id, {
      disable_notification: true
    });
    await ctx.reply('Message pinned.');
  } catch (error) {
    await ctx.reply('Could not pin that message. Make sure I have pin message admin rights.');
    console.error(`Could not pin in ${ctx.chat.id}:`, error.message);
  }
}

async function unpinMessage(ctx) {
  if (!await ensureGroupAdmin(ctx)) return;

  const reply = getUpdateMessage(ctx)?.reply_to_message;
  try {
    if (reply?.message_id) {
      await bot.telegram.unpinChatMessage(ctx.chat.id, reply.message_id);
    } else {
      await bot.telegram.unpinAllChatMessages(ctx.chat.id);
    }
    await ctx.reply(reply?.message_id ? 'Message unpinned.' : 'All pinned messages unpinned.');
  } catch (error) {
    await ctx.reply('Could not unpin. Make sure I have pin message admin rights.');
    console.error(`Could not unpin in ${ctx.chat.id}:`, error.message);
  }
}

async function setSlowMode(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const raw = args[0];
  if (!raw) {
    await ctx.reply('Usage: /slowmode 10 or /slowmode off');
    return;
  }

  const normalized = String(raw).toLowerCase();
  const parsedDelay = Number(raw);
  const delay = ['off', '0', 'none'].includes(normalized)
    ? 0
    : Number.isFinite(parsedDelay) && parsedDelay >= 0
      ? Math.min(Math.ceil(parsedDelay), 3600)
      : null;

  if (delay == null) {
    await ctx.reply('Usage: /slowmode 10 or /slowmode off');
    return;
  }

  try {
    await bot.telegram.callApi('setChatSlowModeDelay', {
      chat_id: ctx.chat.id,
      slow_mode_delay: delay
    });
    await ctx.reply(delay ? `Slowmode set to ${delay} second(s).` : 'Slowmode turned off.');
  } catch (error) {
    await ctx.reply('Could not set slowmode. Make sure I have manage chat admin rights.');
    console.error(`Could not set slowmode in ${ctx.chat.id}:`, error.message);
  }
}

async function lockChat(ctx) {
  if (!await ensureGroupAdmin(ctx)) return;

  try {
    await bot.telegram.setChatPermissions(ctx.chat.id, {
      can_send_messages: false
    });
    await ctx.reply('Chat locked. Members cannot send messages until /unlock.');
  } catch (error) {
    await ctx.reply('Could not lock the chat. Make sure I have manage chat admin rights.');
    console.error(`Could not lock chat ${ctx.chat.id}:`, error.message);
  }
}

async function unlockChat(ctx) {
  if (!await ensureGroupAdmin(ctx)) return;

  try {
    await bot.telegram.setChatPermissions(ctx.chat.id, openChatPermissions());
    await ctx.reply('Chat unlocked.');
  } catch (error) {
    await ctx.reply('Could not unlock the chat. Make sure I have manage chat admin rights.');
    console.error(`Could not unlock chat ${ctx.chat.id}:`, error.message);
  }
}

async function saveNote(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const name = normalizeNoteName(args[0]);
  const text = args.slice(1).join(' ').trim() || getReplyText(ctx).trim();
  if (!name || !text) {
    await ctx.reply('Usage: /save name note text, or reply to text with /save name');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  await updateGroupSettings(ctx.chat.id, {
    notes: {
      ...(settings.notes ?? {}),
      [name]: text.slice(0, 3500)
    }
  });
  await ctx.reply(`Saved note: ${name}`);
  await sendTelegramBackup(`Saved note ${name} for chat ${ctx.chat.id}.`);
}

async function getNote(ctx, args) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Notes work inside groups and supergroups.');
    return;
  }

  const name = normalizeNoteName(args[0]);
  if (!name) {
    await ctx.reply('Usage: /get name');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  const note = settings.notes?.[name];
  await ctx.reply(note || `No note saved as ${name}.`, { disable_web_page_preview: true });
}

async function listNotes(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Notes work inside groups and supergroups.');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  const names = Object.keys(settings.notes ?? {});
  await ctx.reply(names.length ? `Saved notes:\n${names.map((name) => `- ${name}`).join('\n')}` : 'No notes saved yet.');
}

async function deleteNote(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const name = normalizeNoteName(args[0]);
  if (!name) {
    await ctx.reply('Usage: /delnote name');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  const notes = { ...(settings.notes ?? {}) };
  const existed = Boolean(notes[name]);
  delete notes[name];
  await updateGroupSettings(ctx.chat.id, { notes });
  await ctx.reply(existed ? `Deleted note: ${name}` : `No note saved as ${name}.`);
  if (existed) await sendTelegramBackup(`Deleted note ${name} for chat ${ctx.chat.id}.`);
}

async function saveFilter(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const trigger = normalizeFilterTrigger(args[0]);
  const response = args.slice(1).join(' ').trim() || getReplyText(ctx).trim();
  if (!trigger || !response) {
    await ctx.reply('Usage: /filter trigger reply text, or reply to text with /filter trigger');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  await updateGroupSettings(ctx.chat.id, {
    filters: {
      ...(settings.filters ?? {}),
      [trigger]: response.slice(0, 1000)
    }
  });
  await ctx.reply(`Auto-reply filter saved: ${trigger}`);
  await sendTelegramBackup(`Saved filter ${trigger} for chat ${ctx.chat.id}.`);
}

async function listFilters(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('Filters work inside groups and supergroups.');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  const triggers = Object.keys(settings.filters ?? {});
  await ctx.reply(triggers.length ? `Auto-reply filters:\n${triggers.map((trigger) => `- ${trigger}`).join('\n')}` : 'No filters saved yet.');
}

async function deleteFilter(ctx, args) {
  if (!await ensureGroupAdmin(ctx)) return;

  const trigger = normalizeFilterTrigger(args[0]);
  if (!trigger) {
    await ctx.reply('Usage: /stopfilter trigger');
    return;
  }

  const settings = await getGroupSettings(ctx.chat.id);
  const filters = { ...(settings.filters ?? {}) };
  const existed = Boolean(filters[trigger]);
  delete filters[trigger];
  await updateGroupSettings(ctx.chat.id, { filters });
  await ctx.reply(existed ? `Deleted filter: ${trigger}` : `No filter saved as ${trigger}.`);
  if (existed) await sendTelegramBackup(`Deleted filter ${trigger} for chat ${ctx.chat.id}.`);
}

async function handleAutoFilterReplies(ctx) {
  if (!isGroupChat(ctx)) return false;

  const text = getUpdateText(ctx).trim();
  if (!text || text.startsWith('/')) return false;

  const settings = await getGroupSettings(ctx.chat.id);
  const filters = Object.entries(settings.filters ?? {});
  if (filters.length === 0) return false;

  const normalizedText = text.toLowerCase();
  const match = filters.find(([trigger]) => normalizedText.includes(trigger.toLowerCase()));
  if (!match) return false;

  await ctx.reply(match[1], {
    disable_web_page_preview: true
  });
  return true;
}

async function ensureGroupAdmin(ctx) {
  if (!isGroupChat(ctx)) {
    await ctx.reply('That group manager command works inside groups and supergroups.');
    return false;
  }

  if (!ctx.from?.id || !await isUserAdminInChat(ctx.chat.id, ctx.from.id)) {
    await ctx.reply('Only group admins can use that command.');
    return false;
  }

  return true;
}

async function ensureCallbackAdmin(ctx, chatId) {
  if (!ctx.from?.id || !await isUserAdminInChat(chatId, ctx.from.id)) {
    await ctx.answerCbQuery('Only group admins can change this.', { show_alert: true }).catch(() => {});
    return false;
  }

  return true;
}

async function canModerateTarget(ctx, userId) {
  if (String(userId) === String(botId)) {
    await ctx.reply('I cannot moderate myself.');
    return false;
  }

  if (String(userId) === String(ctx.from?.id)) {
    await ctx.reply('You cannot use that command on yourself.');
    return false;
  }

  try {
    const member = await bot.telegram.getChatMember(ctx.chat.id, userId);
    if (['administrator', 'creator'].includes(member.status)) {
      await ctx.reply('I cannot moderate group admins.');
      return false;
    }
  } catch {
    return true;
  }

  return true;
}

async function isUserAdminInChat(chatId, userId) {
  if (!chatId || !userId) return false;

  try {
    const member = await bot.telegram.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error(`Could not check admin status for ${userId} in ${chatId}:`, error.message);
    return false;
  }
}

async function restrictMember(chatId, userId, minutes) {
  const untilDate = Math.floor(Date.now() / 1000) + Math.max(1, minutes) * 60;
  return bot.telegram.restrictChatMember(chatId, userId, {
    until_date: untilDate,
    permissions: {
      can_send_messages: false
    }
  });
}

function openChatPermissions() {
  return {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_invite_users: true
  };
}

function getModerationTarget(ctx, args = [], options = {}) {
  const message = getUpdateMessage(ctx);
  const replyUser = message?.reply_to_message?.from;
  if (replyUser) {
    return {
      userId: replyUser.id,
      user: replyUser,
      rest: args,
      reason: args.join(' ').trim() || options.defaultReason || 'No reason given'
    };
  }

  const first = args[0];
  if (/^\d+$/.test(String(first ?? ''))) {
    const rest = args.slice(1);
    return {
      userId: Number(first),
      user: null,
      rest,
      reason: rest.join(' ').trim() || options.defaultReason || 'No reason given'
    };
  }

  if (options.allowSelf && ctx.from?.id) {
    return {
      userId: ctx.from.id,
      user: ctx.from,
      rest: args,
      reason: options.defaultReason || 'No reason given'
    };
  }

  return null;
}

function renderWelcomeText(template, user, chat) {
  return escapeHtmlForTelegram(template || 'Welcome {user} to {chat}!')
    .replaceAll('{user}', formatUserHtml(user))
    .replaceAll('{chat}', escapeHtmlForTelegram(chat.title ?? 'the group'));
}

function formatUserHtml(user) {
  const name = formatUserLabel(user);
  return `<a href="tg://user?id=${user.id}">${escapeHtmlForTelegram(name)}</a>`;
}

function formatUserLabel(user) {
  if (!user) return 'user';
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || `user ${user.id}`;
}

function parseToggleValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['on', 'enable', 'enabled', 'yes', 'true'].includes(normalized)) return true;
  if (['off', 'disable', 'disabled', 'no', 'false'].includes(normalized)) return false;
  return null;
}

function parseDurationMinutes(value, fallback) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.ceil(minutes), 10080) : fallback;
}

function normalizeNoteName(value) {
  return String(value ?? '')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
}

function normalizeFilterTrigger(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

function containsExternalLink(text) {
  return /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|discord\.gg\/)/i.test(String(text ?? ''));
}

function isGroupChat(ctx) {
  return ['group', 'supergroup'].includes(ctx.chat?.type);
}

function modCallback(...parts) {
  return ['mod', ...parts].filter((part) => part !== '' && part != null).join(':');
}

function renderSettingsMenu(chatId, coins) {
  const message = coins.map((coin) => {
    const settings = getChatSettings(coin, chatId);
    return [
      `$${coin.symbol}`,
      `CA: ${coin.contract}`,
      `Media: ${settings.media ? settings.media.type : 'token metadata'}`,
      `Emojis: ${settings.emojiLine || 'auto'}`,
      `Buy Emoji Scale: ${settings.buyEmoji ? `${settings.buyEmoji.line} every ${settings.buyEmoji.baseSol} SOL` : 'off'}`,
      `Top Movers: ${settings.showTopMovers === false ? 'off' : 'on'}`,
      `Footer: ${settings.showFooter === false ? 'off' : 'on'}`,
      `Bonding: ${settings.showBonding === false ? 'off' : 'on'}`,
      `Socials: ${settings.showSocials === false ? 'off' : 'on'}`
    ].join('\n');
  }).join('\n\n');

  const keyboard = coins.flatMap((coin) => {
    const settings = getChatSettings(coin, chatId);
    return [
      [Markup.button.callback(`$${coin.symbol}`, settingsCallback('noop', coin.symbol))],
      [
        Markup.button.callback(`${buttonState(settings.showTopMovers)} Top Movers`, settingsCallback('toggle', coin.symbol, 'topmovers')),
        Markup.button.callback(`${buttonState(settings.showFooter)} Footer`, settingsCallback('toggle', coin.symbol, 'footer'))
      ],
      [
        Markup.button.callback(`${buttonState(settings.showBonding)} Bonding`, settingsCallback('toggle', coin.symbol, 'bonding')),
        Markup.button.callback(`${buttonState(settings.showSocials)} Socials`, settingsCallback('toggle', coin.symbol, 'socials'))
      ],
      [
        Markup.button.callback('Media / Image', settingsCallback('prompt', coin.symbol, 'media')),
        Markup.button.callback('Emoji Border', settingsCallback('prompt', coin.symbol, 'emoji'))
      ],
      [
        Markup.button.callback('Buy Emoji Scale', settingsCallback('prompt', coin.symbol, 'scale')),
        Markup.button.callback('Auto CA Help', settingsCallback('help', 'autoca'))
      ]
    ];
  });

  return [
    message,
    Markup.inlineKeyboard(keyboard)
  ];
}

function renderEmptySettingsMenu() {
  return [
    [
      'No coin is linked to this chat yet.',
      '',
      'Paste a Pump.fun link or CA after the bot is admin, or use /setcoin SYMBOL CONTRACT.',
      'You can also reply to a CA/Pump.fun link with /autoca.'
    ].join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback('Auto CA Help', settingsCallback('help', 'autoca')),
        Markup.button.callback('Set Coin Help', settingsCallback('help', 'setcoin'))
      ]
    ])
  ];
}

function getSettingKey(key) {
  return {
    topmovers: 'showTopMovers',
    footer: 'showFooter',
    bonding: 'showBonding',
    socials: 'showSocials'
  }[key];
}

function buttonState(value) {
  return value === false ? 'OFF' : 'ON';
}

function settingsCallback(action, symbol, key = '') {
  return ['settings', action, symbol, key].filter(Boolean).join(':');
}

async function handlePendingSettingsReply(ctx) {
  const pending = getPendingSetting(ctx);
  if (!pending) return false;

  const text = getUpdateText(ctx).trim();
  if (text.startsWith('/')) return false;

  try {
    if (pending.action === 'media') {
      const media = getAttachedMedia(ctx) ?? (text ? mediaFromUrl(text) : null);
      if (!media) {
        await ctx.reply('Send an image, GIF, video, or direct media URL.');
        return true;
      }

      const coin = await updateCoinChatSettings(ctx.chat.id, pending.symbol, { media });
      clearPendingSetting(ctx);
      await ctx.reply(`Custom ${media.type} set for $${coin.symbol}.`);
      await sendTelegramBackup(`Set custom media for $${coin.symbol} in chat ${ctx.chat.id}.`);
      return true;
    }

    if (pending.action === 'emoji') {
      if (!text) {
        await ctx.reply('Send the emojis you want on the buy alert.');
        return true;
      }

      const coin = await updateCoinChatSettings(ctx.chat.id, pending.symbol, { emojiLine: text });
      clearPendingSetting(ctx);
      await ctx.reply(`Custom emojis set for $${coin.symbol}.`);
      await sendTelegramBackup(`Set custom emojis for $${coin.symbol} in chat ${ctx.chat.id}.`);
      return true;
    }

    if (pending.action === 'scale') {
      const buyEmoji = parseBuyEmojiValue(text);
      if (!buyEmoji) {
        await ctx.reply('Send it like: 0.25 🧌🧌🧌');
        return true;
      }

      const coin = await updateCoinChatSettings(ctx.chat.id, pending.symbol, { buyEmoji });
      clearPendingSetting(ctx);
      await ctx.reply(`Buy emoji scaling set for $${coin.symbol}: one line every ${buyEmoji.baseSol} SOL.`);
      await sendTelegramBackup(`Set buy emoji scaling for $${coin.symbol} in chat ${ctx.chat.id}.`);
      return true;
    }
  } catch (error) {
    clearPendingSetting(ctx);
    await ctx.reply(error.message);
    return true;
  }

  return false;
}

function setPendingSetting(chatId, userId, value) {
  if (!chatId || !userId) return;
  pendingSettings.set(`${chatId}:${userId}`, {
    ...value,
    expiresAt: Date.now() + 5 * 60 * 1000
  });
}

function getPendingSetting(ctx) {
  const key = getPendingSettingKey(ctx);
  if (!key) return null;

  const pending = pendingSettings.get(key);
  if (!pending) return null;
  if (pending.expiresAt < Date.now()) {
    pendingSettings.delete(key);
    return null;
  }

  return pending;
}

function clearPendingSetting(ctx) {
  const key = getPendingSettingKey(ctx);
  if (key) pendingSettings.delete(key);
}

function getPendingSettingKey(ctx) {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  return userId && chatId ? `${chatId}:${userId}` : null;
}

function parseBuyEmojiValue(value) {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return null;

  const baseSol = Number(match[1]);
  const line = match[2].trim();
  if (!Number.isFinite(baseSol) || baseSol <= 0 || !line) return null;

  return {
    baseSol,
    line: line.slice(0, 80)
  };
}

async function rememberChat(chat, options = {}) {
  if (!chat?.id || chat.type === 'private') return;

  const key = String(chat.id);
  const lastSeen = knownChatMemory.get(key) ?? 0;
  if (!options.force && Date.now() - lastSeen < 10 * 60 * 1000) return;

  knownChatMemory.set(key, Date.now());
  await recordKnownChat(chat).catch((error) => {
    console.error(`Could not remember chat ${key}:`, error.message);
  });
}

async function recoverKnownChatTracking() {
  const chats = await getKnownChats();
  if (chats.length === 0) return;

  let recovered = 0;
  for (const chat of chats) {
    const existingCoins = await getCoinsByChat(chat.id);
    if (existingCoins.length > 0) continue;

    try {
      const fullChat = await bot.telegram.getChat(chat.id);
      await rememberChat(fullChat, { force: true });
      const text = buildChatDiscoveryText({ chat, fullChat });
      const contract = extractBestSolanaContract(text, { allowBare: true });
      if (!contract) continue;
      if (!await isBotAdminInChat(chat.id)) continue;

      const coin = await autoTrackContractForChat({
        chatId: chat.id,
        chatTitle: fullChat.title ?? chat.title,
        chatUsername: fullChat.username ?? chat.username,
        contract,
        reply: (message) => bot.telegram.sendMessage(chat.id, message).catch((error) => {
          console.error(`Could not send auto-recovery notice to ${chat.id}:`, error.message);
        })
      });
      if (coin) recovered += 1;
    } catch (error) {
      console.error(`Could not recover tracking for chat ${chat.id}:`, error.message);
    }
  }

  if (recovered > 0) {
    restartBitqueryStreamSoon();
    restartPumpPortalStreamSoon();
    restartNativeSolanaWatcherSoon();
    console.log(`Auto-recovered ${recovered} chat CA tracking setup(s).`);
  }
}

async function getAutoTrackDiscoveryText(ctx, options = {}) {
  const message = getUpdateMessage(ctx);
  let fullChat = null;

  if (options.includeChatProfile) {
    try {
      fullChat = await bot.telegram.getChat(ctx.chat.id);
    } catch (error) {
      console.error(`Could not read chat profile for ${ctx.chat.id}:`, error.message);
    }
  }

  return [
    getUpdateTextWithReply(ctx),
    message?.pinned_message?.text,
    message?.pinned_message?.caption,
    buildChatDiscoveryText({ chat: ctx.chat, fullChat })
  ].filter(Boolean).join('\n');
}

function buildChatDiscoveryText({ chat, fullChat }) {
  return [
    chat?.title,
    chat?.username,
    fullChat?.title,
    fullChat?.username,
    fullChat?.description,
    fullChat?.bio,
    fullChat?.pinned_message?.text,
    fullChat?.pinned_message?.caption
  ].filter(Boolean).join('\n');
}

async function autoTrackContractFromChat(ctx, options = {}) {
  if (!ctx.chat || ctx.chat.type === 'private') return;
  await rememberChat(ctx.chat);

  const existingCoins = await getCoinsByChat(ctx.chat.id);
  const text = await getAutoTrackDiscoveryText(ctx, {
    includeChatProfile: options.force || existingCoins.length === 0
  });
  const hasExplicitCaContext = hasCaContext(text);
  if (existingCoins.length > 0 && !options.force && !hasExplicitCaContext) return;

  const isAdmin = await isBotAdminInChat(ctx.chat.id);
  if (!isAdmin) return;

  const contract = extractBestSolanaContract(text, {
    allowBare: options.force || existingCoins.length === 0 || hasExplicitCaContext
  });
  if (!contract) {
    if (options.notifyNoContract) {
      await ctx.reply('Paste a Pump.fun link or Solana CA in this chat, or reply to one with /autoca.');
    }
    return;
  }

  if (existingCoins.some((coin) => coin.contract?.toLowerCase() === contract.toLowerCase())) {
    if (options.notifyNoContract) {
      await ctx.reply('This chat is already tracking that CA.');
    }
    return;
  }

  await autoTrackContractForChat({
    chatId: ctx.chat.id,
    chatTitle: ctx.chat.title,
    chatUsername: ctx.chat.username,
    contract,
    reply: (message) => ctx.reply(message)
  });
}

async function autoTrackContractForChat({ chatId, chatTitle, chatUsername, contract, reply }) {
  await recordKnownChat({
    id: chatId,
    title: chatTitle,
    username: chatUsername
  });

  const existingCoins = await getCoinsByChat(chatId);
  if (existingCoins.some((coin) => coin.contract?.toLowerCase() === contract.toLowerCase())) {
    return null;
  }

  const tokenMeta = await getTokenMetadata(contract);
  const symbol = normalizeAutoSymbol(tokenMeta?.symbol || chatTitle || chatUsername || 'COIN');
  const buyUrl = `https://pump.fun/coin/${contract}`;
  const coin = await addChannelToCoinByContract(contract, chatId, {
    symbol,
    name: tokenMeta?.name || symbol,
    buyUrl,
    website: tokenMeta?.website || buyUrl,
    imageUrl: tokenMeta?.imageUrl,
    twitter: tokenMeta?.twitter,
    telegram: tokenMeta?.telegram
  });
  const heliusResult = await ensureHeliusTracksContract(coin.contract);
  restartBitqueryStreamSoon();
  restartPumpPortalStreamSoon();
  restartNativeSolanaWatcherSoon();

  await reply([
    `Auto-tracked $${coin.symbol} from this chat.`,
    coin.contract,
    renderHeliusSyncStatus(heliusResult)
  ].filter(Boolean).join('\n'));
  await sendTelegramBackup(`Auto-tracked ${coin.symbol} ${coin.contract} for chat ${chatId}.`);
  return coin;
}

function getChatSettings(coin, chatId) {
  return coin.chatSettings?.[String(chatId)] ?? {};
}

function getAttachedMedia(ctx) {
  const message = ctx.message
    ?? ctx.channelPost
    ?? ctx.editedMessage
    ?? ctx.editedChannelPost;
  const reply = message?.reply_to_message;
  const source = reply ?? message;
  const photo = source?.photo?.at(-1);

  if (photo?.file_id) {
    return { type: 'photo', value: photo.file_id };
  }

  if (source?.video?.file_id) {
    return { type: 'video', value: source.video.file_id };
  }

  if (source?.animation?.file_id) {
    return { type: 'animation', value: source.animation.file_id };
  }

  return null;
}

function mediaFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const cleanUrl = url.trim();
  const type = /\.(mp4|mov|webm)(\?|$)/i.test(cleanUrl) ? 'video' : 'photo';
  return { type, value: cleanUrl };
}

function parseOptionalTargetAndValue(ctx, args) {
  const mediaUrl = args.find((arg) => /^https?:\/\//i.test(arg));
  const target = args.find((arg) => arg !== mediaUrl);
  return { target, mediaUrl };
}

async function parseOptionalCoinTarget(chatId, args) {
  const coins = await getCoinsByChat(chatId);
  const first = args[0]?.replace(/^\$+/, '').toLowerCase();
  const hasTarget = coins.some((coin) => (
    coin.symbol?.toLowerCase() === first
    || coin.contract?.toLowerCase() === first
  ));

  return {
    target: hasTarget ? args[0] : undefined,
    value: hasTarget ? args.slice(1).join(' ') : args.join(' ')
  };
}

async function parseBuySettingsArgs(chatId, args) {
  const coins = await getCoinsByChat(chatId);
  const first = args[0]?.replace(/^\$+/, '').toLowerCase();
  const hasTarget = coins.some((coin) => (
    coin.symbol?.toLowerCase() === first
    || coin.contract?.toLowerCase() === first
  ));
  const parts = hasTarget ? args.slice(1) : args;
  const key = parts[0]?.toLowerCase();
  const value = parts[1]?.toLowerCase();
  const enabled = value === 'on' || value === 'true' || value === 'yes'
    ? true
    : value === 'off' || value === 'false' || value === 'no'
      ? false
      : null;

  return {
    target: hasTarget ? args[0] : undefined,
    key,
    enabled
  };
}

function extractSolanaContract(text, options = {}) {
  const pumpMatch = text.match(/pump\.fun\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (pumpMatch) return pumpMatch[1];

  if (!options.allowBare && !hasCaContext(text)) return null;

  const caMatch = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
  return caMatch?.[0] ?? null;
}

function extractBestSolanaContract(text, options = {}) {
  const value = String(text ?? '');
  const pumpLink = value.match(/pump\.fun\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (pumpLink) return pumpLink[1];

  const pumpSuffix = value.match(/\b[1-9A-HJ-NP-Za-km-z]{28,44}pump\b/i);
  if (pumpSuffix) return pumpSuffix[0];

  const explicit = extractSolanaContract(value, { allowBare: false });
  if (explicit) return explicit;

  return options.allowBare ? extractSolanaContract(value, { allowBare: true }) : null;
}

function hasCaContext(text) {
  return /pump\.fun\/coin\//i.test(text)
    || /\b(ca|contract|mint|token)\b\s*[:=]?/i.test(text);
}

function normalizeAutoSymbol(value) {
  const cleaned = String(value)
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 12)
    .toUpperCase();

  return cleaned || 'COIN';
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
    await sendTelegramBackup(`Tracked $${coin.symbol} in chat ${ctx.chat.id}.`);
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
      chartUrl: getDexScreenerChartUrl(coin.contract)
    }
  });

  await ctx.reply(`Sent a test buy alert for $${coin.symbol}.`);
}

async function sendTelegramBackup(reason = 'Backup') {
  if (!telegramBackupChatId) return;

  try {
    const store = await readStore();
    const backup = {
      type: 'OgreBuyBotBackup',
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      store
    };

    await bot.telegram.sendMessage(
      telegramBackupChatId,
      [
        '<b>OgreBuyBot Backup</b>',
        escapeHtmlForTelegram(reason),
        '<pre>',
        escapeHtmlForTelegram(JSON.stringify(backup)),
        '</pre>'
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error('Telegram backup failed:', error.message);
  }
}

async function restoreTelegramBackupFromReply(ctx) {
  const replyText = ctx.message?.reply_to_message?.text
    ?? ctx.message?.reply_to_message?.caption
    ?? ctx.editedMessage?.reply_to_message?.text
    ?? ctx.editedMessage?.reply_to_message?.caption
    ?? ctx.channelPost?.reply_to_message?.text
    ?? ctx.channelPost?.reply_to_message?.caption
    ?? ctx.editedChannelPost?.reply_to_message?.text
    ?? ctx.editedChannelPost?.reply_to_message?.caption
    ?? '';

  const backup = parseTelegramBackup(replyText);
  if (!backup?.store) {
    await ctx.reply('Reply to an OgreBuyBot backup message, then run /restore_backup.');
    return null;
  }

  return replaceStore(backup.store);
}

function parseTelegramBackup(text) {
  const trimmed = String(text ?? '').trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.type === 'OgreBuyBotBackup' ? parsed : null;
  } catch {
    return null;
  }
}

function escapeHtmlForTelegram(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function postBuyAlert({ coin, eventInput }) {
  if (isSellLikeEvent(eventInput)) {
    return { ignored: true, reason: 'sell-event', results: [], channels: [] };
  }

  const event = await recordBuyEvent({
    ...eventInput,
    symbol: coin.symbol,
    contract: eventInput.contract ?? coin.contract,
    chartUrl: eventInput.chartUrl ?? coin.chartUrl ?? getDexScreenerChartUrl(eventInput.contract ?? coin.contract),
    quoteSymbol: eventInput.quoteSymbol ?? DEFAULT_QUOTE_SYMBOL
  });

  if (!event) {
    return { duplicate: true, results: [], channels: [] };
  }

  const [
    trending,
    primaryCoin,
    tokenMeta,
    channels
  ] = await Promise.all([
    getTrendingCoins(Number(TRENDING_LIMIT)),
    getPrimaryCoin(),
    getCachedTokenMetadata(coin.contract),
    getEligibleAlertChannels(coin)
  ]);

  const results = await Promise.allSettled(
    channels.map((chatId) => {
      const chatSettings = getChatSettings(coin, chatId);
      const message = renderBuyAlert({ coin, event, trending, primaryCoin, tokenMeta, chatSettings });
      const media = chatSettings.media ?? (tokenMeta?.imageUrl ? { type: 'photo', value: tokenMeta.imageUrl } : null);
      return sendBuyAlertToChat(chatId, message, media);
    })
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to send $${coin.symbol} buy alert to chat ${channels[index]}:`, result.reason);
    }
  });

  return { event, results, channels };
}

async function sendBuyAlertToChat(chatId, message, media) {
  const tradeButton = getBuyAlertTradeButton();

  if (media?.value) {
    try {
      if (media.type === 'video') {
        return await bot.telegram.sendVideo(chatId, media.value, {
          caption: message,
          parse_mode: 'HTML',
          ...tradeButton
        });
      }

      if (media.type === 'animation') {
        return await bot.telegram.sendAnimation(chatId, media.value, {
          caption: message,
          parse_mode: 'HTML',
          ...tradeButton
        });
      }

      return await bot.telegram.sendPhoto(chatId, media.value, {
        caption: message,
        parse_mode: 'HTML',
        ...tradeButton
      });
    } catch (error) {
      console.error(`Failed to send token media to ${chatId}, falling back to text:`, error.message);
    }
  }

  return bot.telegram.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...tradeButton
  });
}

function getBuyAlertTradeButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Trade @OgreTradeBot', url: OGRE_TRADE_BOT_URL }]
      ]
    }
  };
}

function getAlertChannels(coin) {
  return Array.from(new Set((coin.channels ?? []).map(String).filter(Boolean)));
}

function getDexScreenerChartUrl(contract) {
  return `https://dexscreener.com/solana/${encodeURIComponent(contract)}`;
}

function isSellLikeEvent(eventInput = {}) {
  const side = String(eventInput.side ?? eventInput.txType ?? eventInput.type ?? '').toLowerCase();
  return side === 'sell' || side === 'token_sell' || side.includes('sell');
}

async function getEligibleAlertChannels(coin) {
  const configuredChannels = getAlertChannels(coin);
  const results = await Promise.all(
    configuredChannels.map(async (chatId) => ({
      chatId,
      isAdmin: await isBotAdminInChat(chatId)
    }))
  );

  return results
    .filter((result) => result.isAdmin)
    .map((result) => result.chatId);
}

async function isBotAdminInChat(chatId) {
  const normalizedChatId = String(chatId);
  const cached = adminStatusCache.get(normalizedChatId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isAdmin;
  }

  try {
    const member = await bot.telegram.getChatMember(chatId, botId ?? bot.botInfo?.id);
    const isAdmin = ['administrator', 'creator'].includes(member.status);
    adminStatusCache.set(normalizedChatId, {
      isAdmin,
      expiresAt: Date.now() + Math.max(0, Number(ADMIN_STATUS_CACHE_MS) || 300000)
    });
    return isAdmin;
  } catch (error) {
    console.error(`Skipping buy alert for chat ${chatId}; bot admin check failed:`, error.message);
    adminStatusCache.set(normalizedChatId, {
      isAdmin: false,
      expiresAt: Date.now() + 30000
    });
    return false;
  }
}

async function parseHeliusTransaction(transaction) {
  const tokenTransfers = [
    ...(transaction.tokenTransfers ?? []).map((transfer) => ({ ...transfer, sourceType: 'token-transfer' })),
    ...getSwapTokenOutputs(transaction),
    ...getTokenBalanceChangeOutputs(transaction)
  ];
  const nativeTransfers = transaction.nativeTransfers ?? [];
  const signature = transaction.signature;
  const source = transaction.source ?? transaction.type ?? 'helius';
  const feePayer = transaction.feePayer;
  const hasSwapContext = isLikelySwapBuy(transaction);
  const events = [];

  for (const transfer of tokenTransfers) {
    const contract = transfer.mint;
    if (!contract) continue;

    const buyer = transfer.toUserAccount ?? transfer.userAccount ?? feePayer;
    if (!buyer) continue;

    if (feePayer && buyer !== feePayer) {
      continue;
    }

    if (!hasSwapContext && transfer.sourceType !== 'swap-output') {
      continue;
    }

    const solSpent = getSolSpentByWallet(transaction, nativeTransfers, buyer, {
      allowBalanceChangeFallback: hasSwapContext
    });
    if (solSpent < minBuySol) continue;

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
      chartUrl: getDexScreenerChartUrl(contract),
      txUrl: signature ? `https://solscan.io/tx/${signature}` : undefined
    });
  }

  return events;
}

function getSwapTokenOutputs(transaction) {
  const outputs = transaction.events?.swap?.tokenOutputs ?? [];

  return outputs.map((output) => ({
    mint: output.mint,
    sourceType: 'swap-output',
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
          sourceType: 'balance-change',
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

function getSolSpentByWallet(transaction, nativeTransfers, wallet, options = {}) {
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

  if (!options.allowBalanceChangeFallback) {
    return 0;
  }

  const balanceChange = (transaction.accountData ?? [])
    .filter((account) => account.account === wallet && Number(account.nativeBalanceChange ?? 0) < 0)
    .reduce((total, account) => total + Math.abs(Number(account.nativeBalanceChange ?? 0)), 0);

  const solChange = balanceChange / 1_000_000_000;
  return solChange >= minBuySol ? solChange : 0;
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

  const storedCoin = await getCoinByContract(contract);
  const storedMeta = storedCoin ? {
    source: 'store',
    name: storedCoin.name,
    symbol: storedCoin.symbol,
    imageUrl: storedCoin.imageUrl,
    twitter: storedCoin.twitter,
    telegram: storedCoin.telegram,
    website: storedCoin.website
  } : null;

  const pumpMeta = await getPumpFunMetadata(contract);
  if (pumpMeta?.imageUrl || pumpMeta?.bondingProgress != null) {
    return { ...storedMeta, ...pumpMeta };
  }

  const heliusMeta = await getHeliusAssetMetadata(contract);
  return { ...storedMeta, ...(heliusMeta ?? pumpMeta ?? {}) };
}

async function getCachedTokenMetadata(contract) {
  if (!contract) return null;

  const normalizedContract = contract.toLowerCase();
  const ttl = Math.max(0, Number(TOKEN_METADATA_CACHE_MS) || 30000);
  const cached = tokenMetadataCache.get(normalizedContract);

  if (ttl > 0 && cached?.value && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (ttl > 0 && cached?.promise) {
    return cached.promise;
  }

  const promise = getTokenMetadata(contract)
    .then((value) => {
      tokenMetadataCache.set(normalizedContract, {
        value,
        expiresAt: Date.now() + ttl
      });
      return value;
    })
    .catch((error) => {
      tokenMetadataCache.delete(normalizedContract);
      throw error;
    });

  if (ttl > 0) {
    tokenMetadataCache.set(normalizedContract, {
      promise,
      expiresAt: Date.now() + ttl
    });
  }

  return promise;
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
      bondingProgress,
      rawProgressFields: {
        bonding_curve_progress: coin.bonding_curve_progress,
        bondingCurveProgress: coin.bondingCurveProgress,
        graduationPercent: coin.graduationPercent,
        progress: coin.progress,
        real_token_reserves: coin.real_token_reserves,
        initial_real_token_reserves: coin.initial_real_token_reserves,
        real_sol_reserves: coin.real_sol_reserves,
        usd_market_cap: coin.usd_market_cap,
        market_cap: coin.market_cap
      },
      marketCapUsd: coin.usd_market_cap ?? coin.market_cap,
      twitter: coin.twitter,
      telegram: coin.telegram,
      website: coin.website
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

  const reserveProgress = getPumpFunReserveProgress(coin);
  if (reserveProgress != null) return reserveProgress;

  const usdMarketCap = Number(coin.usd_market_cap ?? coin.market_cap);
  const graduationMarketCap = Number(coin.king_of_the_hill_market_cap ?? coin.raydium_migration_market_cap ?? 69000);

  if (Number.isFinite(usdMarketCap) && Number.isFinite(graduationMarketCap) && graduationMarketCap > 0) {
    return Math.min(100, (usdMarketCap / graduationMarketCap) * 100);
  }

  return null;
}

function getPumpFunReserveProgress(coin) {
  const realTokenReserves = Number(coin.real_token_reserves ?? coin.realTokenReserves);
  const initialRealTokenReserves = Number(
    coin.initial_real_token_reserves
      ?? coin.initialRealTokenReserves
  );

  if (
    Number.isFinite(realTokenReserves)
    && Number.isFinite(initialRealTokenReserves)
    && initialRealTokenReserves > 0
  ) {
    return Math.max(0, Math.min(100, ((initialRealTokenReserves - realTokenReserves) / initialRealTokenReserves) * 100));
  }

  const realSolReserves = Number(coin.real_sol_reserves ?? coin.realSolReserves);

  if (Number.isFinite(realSolReserves) && realSolReserves > 0) {
    const estimatedCompletionLamports = 85 * 1_000_000_000;
    return Math.max(0, Math.min(100, (realSolReserves / estimatedCompletionLamports) * 100));
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
