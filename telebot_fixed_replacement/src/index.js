import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { z } from 'zod';
import {
  addChannelToCoin,
  getCoin,
  getTrendingCoins,
  readStore,
  recordBuyEvent,
  upsertCoin
} from './store.js';
import { renderBuyAlert, renderCoinList } from './render.js';

const {
  BOT_TOKEN,
  PORT = 3000,
  WEBHOOK_SECRET,
  DEFAULT_QUOTE_SYMBOL = 'SOL',
  TRENDING_LIMIT = 5
} = process.env;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required. Copy .env.example to .env and add your Telegram bot token.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json({ limit: '1mb' }));

const buyEventSchema = z.object({
  symbol: z.string().min(1),
  buyer: z.string().optional(),
  tokenAmount: z.coerce.number().nonnegative(),
  usdValue: z.coerce.number().nonnegative().default(0),
  quoteAmount: z.coerce.number().nonnegative().optional(),
  quoteSymbol: z.string().optional(),
  marketCap: z.coerce.number().nonnegative().optional(),
  txUrl: z.string().url().optional()
});

bot.start((ctx) => {
  return ctx.reply([
    'Buy bot is online.',
    '',
    'Commands:',
    '/coins - list tracked coins',
    '/track OGRE - add this chat/channel to a coin',
    '/addcoin SYMBOL Name | chain | contract | buyUrl - register a coin'
  ].join('\n'));
});

bot.command('coins', async (ctx) => {
  const store = await readStore();
  await ctx.reply(renderCoinList(store.coins), { disable_web_page_preview: true });
});

bot.command('track', async (ctx) => {
  const symbol = getUpdateText(ctx).split(/\s+/)[1];
  if (!symbol) {
    await ctx.reply('Usage: /track OGRE');
    return;
  }

  try {
    const coin = await addChannelToCoin(symbol, ctx.chat.id);
    await ctx.reply(`This chat is now tracking $${coin.symbol}. Make sure the bot is admin if this is a channel.`);
  } catch (error) {
    await ctx.reply(error.message);
  }
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

  await ctx.reply(`Added $${coin.symbol} and linked it to this chat.`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
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

  const coin = await getCoin(parsed.data.symbol);
  if (!coin?.enabled) {
    res.status(404).json({ error: `Coin ${parsed.data.symbol} is not registered or is disabled.` });
    return;
  }

  const event = await recordBuyEvent({
    ...parsed.data,
    quoteSymbol: parsed.data.quoteSymbol ?? DEFAULT_QUOTE_SYMBOL
  });
  const trending = await getTrendingCoins(Number(TRENDING_LIMIT));
  const message = renderBuyAlert({ coin, event, trending });
  const channels = coin.channels ?? [];

  const results = await Promise.allSettled(
    channels.map((chatId) => bot.telegram.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }))
  );

  res.json({
    ok: true,
    sent: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length,
    event
  });
});

bot.catch((error, ctx) => {
  console.error(`Telegram error for update ${ctx.update?.update_id ?? 'unknown'}:`, error);
});

async function main() {
  const me = await bot.telegram.getMe();
  console.log(`Telegram bot connected as @${me.username}`);

  await bot.launch({
    dropPendingUpdates: true
  });
  console.log('Telegram polling started. Leave this window open.');

  app.listen(Number(PORT), () => {
    console.log(`Buy bot API listening on http://localhost:${PORT}`);
  });
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
