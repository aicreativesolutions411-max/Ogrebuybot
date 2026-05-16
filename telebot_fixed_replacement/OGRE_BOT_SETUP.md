# OGRE Telegram Buy Bot Setup

This folder contains a Telegram buy-alert bot for `$OGRE`.

## OGRE Coin Details

- Symbol: `OGRE`
- Chain: `solana`
- Contract address: `5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump`
- Buy link: `https://pump.fun/coin/5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump`

## What The Bot Does

- Replies to Telegram commands.
- Tracks `$OGRE` by default.
- Posts buy alerts into Telegram chats/channels that run `/track OGRE`.
- Shows other trending coins that also use the bot.
- Receives buy alerts through `POST /api/buy`.

## Important

Creating a bot in BotFather is only step one. The code must also be running on your PC or on a server.

## Local Setup

1. Install Node.js from:

   `https://nodejs.org/`

2. Open PowerShell in the bot folder.

3. Install dependencies:

   ```powershell
   npm install
   ```

4. Copy `.env.example` to `.env`.

   ```powershell
   copy .env.example .env
   ```

5. Edit `.env` and set:

   ```env
   BOT_TOKEN=your_botfather_token_here
   WEBHOOK_SECRET=change-me
   PORT=3000
   ```

6. Start the bot:

   ```powershell
   npm run dev
   ```

7. Message your Telegram bot:

   ```text
   /start
   /coins
   ```

## Add Bot To OGRE Channel

1. Add the Telegram bot to your OGRE group or channel.
2. If it is a channel, make the bot an admin.
3. Send this inside the group/channel:

   ```text
   /track OGRE
   ```

## Test A Fake Buy Alert

With the bot running, run this in PowerShell:

```powershell
curl -Method POST http://localhost:3000/api/buy `
  -Headers @{"Content-Type"="application/json";"x-bot-secret"="change-me"} `
  -Body '{"symbol":"OGRE","buyer":"9xQeWvG816bUx9EPf3YEXAMPLE","tokenAmount":125000,"usdValue":420.69,"quoteAmount":3.2,"quoteSymbol":"SOL","marketCap":1250000,"txUrl":"https://solscan.io/tx/example"}'
```

If `/track OGRE` worked, the bot should post a buy alert.

## Real Buy Detection

This starter bot has the Telegram posting and webhook system ready. To post real buys automatically, connect `/api/buy` to a Solana data provider such as:

- Helius webhooks
- Moralis Streams
- Bitquery
- A custom Solana listener

## Files

- `src/index.js`: main bot and API server
- `src/store.js`: JSON storage
- `src/render.js`: Telegram message formatting
- `data/coins.json`: OGRE and tracked coin settings
- `.env.example`: environment variable template
- `README.md`: project README

## Security

Your Telegram bot token is a password. Do not post it publicly. If you already shared it somewhere public, regenerate it in BotFather.
