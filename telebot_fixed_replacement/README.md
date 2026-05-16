# Telegram Buy Bot

Starter Telegram buy-alert bot for `$OGRE` with a rotating trending section for other coins using the same bot in their channels.

## What It Does

- Posts buy alerts to Telegram chats/channels that track a coin.
- Makes `$OGRE` the primary featured coin by default.
- Stores coins and recent buy events in `data/coins.json`.
- Builds a "Trending with this bot" section from the last 24 hours of buy events.
- Exposes a protected `POST /api/buy` endpoint for a chain listener, indexer, or manual webhook.

This is the Telegram and routing layer. To detect real buys automatically, connect `/api/buy` to a Solana/EVM listener, DEX indexer, Helius webhook, Moralis stream, Bitquery stream, or your own backend.

## Setup

```bash
npm install
copy .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=your-telegram-bot-token
WEBHOOK_SECRET=a-private-secret
PORT=3000
```

Start it:

```bash
npm run dev
```

## Telegram Usage

1. Create a bot with BotFather and put the token in `.env`.
2. Add the bot to your `$OGRE` Telegram channel or group.
3. If it is a channel, make the bot an admin so it can post.
4. In the chat, run:

```text
/track OGRE
```

Add another coin:

```text
/addcoin PEPE Pepe Coin | ethereum | 0x123... | https://example.com/buy-pepe
```

List coins:

```text
/coins
```

## Send A Buy Event

Use your secret in the `x-bot-secret` header:

```bash
curl -X POST http://localhost:3000/api/buy ^
  -H "Content-Type: application/json" ^
  -H "x-bot-secret: change-me" ^
  -d "{\"symbol\":\"OGRE\",\"buyer\":\"9xQeWvG816bUx9EPf3YEXAMPLE\",\"tokenAmount\":125000,\"usdValue\":420.69,\"quoteAmount\":3.2,\"quoteSymbol\":\"SOL\",\"marketCap\":1250000,\"txUrl\":\"https://solscan.io/tx/example\"}"
```

## Customize `$OGRE`

Edit `data/coins.json` and replace:

- `contract`
- `website`
- `buyUrl`
- `emoji`
- `adText`

## Production Notes

- Run the bot on a VPS or app host with a public HTTPS URL.
- Keep `WEBHOOK_SECRET` private.
- Replace JSON storage with Postgres/Redis before high traffic.
- Add a real chain/indexer listener for automatic buy detection.
- Telegram channel IDs are negative numbers. The `/track` command stores them automatically when used inside the target chat.
