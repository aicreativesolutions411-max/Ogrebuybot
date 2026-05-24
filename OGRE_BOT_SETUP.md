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
- Adds a `Trade` button under buy alerts that opens `https://t.me/ogretradebot`.
- Shows other trending coins that also use the bot.
- Receives buy alerts through `POST /api/buy`.
- Can also manage groups with rules, welcomes, anti-link moderation, warnings, mutes, kicks, bans, cleanups, pins, slowmode, locks, notes, filters, and clickable `/modsettings`.

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

This starter bot has the Telegram posting and webhook system ready. It does not magically read Telegram channels or Pump.fun by itself. To post real buys automatically, connect `/api/buy` to a Solana data provider such as:

- Helius webhooks
- Moralis Streams
- Bitquery
- A custom Solana listener

The webhook accepts either `symbol` or `contract`. For OGRE, use:

```json
{
  "contract": "5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump",
  "buyer": "buyer-wallet",
  "tokenAmount": 125000,
  "usdValue": 420.69,
  "quoteAmount": 3.2,
  "quoteSymbol": "SOL",
  "dex": "pump.fun",
  "txUrl": "https://solscan.io/tx/..."
}
```

When the bot receives that payload, it posts to every Telegram chat/channel that ran `/track OGRE`.

## Telegram Commands

The code now registers these commands automatically when the bot starts:

- `/help`
- `/coins`
- `/trending`
- `/track OGRE`
- `/testbuy OGRE`
- `/addcoin SYMBOL Name | chain | contract | buyUrl`
- `/modsettings`
- `/rules`
- `/setrules rules text`
- `/welcome on|off`
- `/setwelcome Welcome {user} to {chat}!`
- `/antilinks on|off`
- `/warn`
- `/warnings`
- `/clearwarns`
- `/mute`
- `/unmute`
- `/kick`
- `/ban`
- `/unban`
- `/clean 20`
- `/pin`
- `/unpin`
- `/slowmode 10`
- `/lock`
- `/unlock`
- `/save name text`
- `/get name`
- `/notes`
- `/delnote name`
- `/filter trigger reply text`
- `/filters`
- `/stopfilter trigger`

If the command menu does not show right away in Telegram, restart the bot and wait a minute. You can still type the commands manually.

## Group Manager Setup

1. Add the bot to your group as admin.
2. Give it permission to delete messages, ban users, and restrict users.
3. Open the clickable menu:

   ```text
   /modsettings
   ```

   The menu stays in one Telegram message. Use the submenu buttons for Protection, Welcome, Rules & Notes, Filters, and Chat Tools, then use Back to keep making changes without spamming the chat.

The bot also self-heals CA setup after restarts. It remembers groups/channels it sees, scans every chat already attached to a tracked coin, and checks pinned messages, chat descriptions, replies, and Pump.fun links for a CA.

The `DEX PAID` badge is checked through DexScreener paid orders and only shows when a paid order exists.

## Overnight Reliability

For Render, keep these enabled so the bot does not look alive while buy listeners have gone stale:

```env
ENABLE_KEEP_ALIVE=true
KEEP_ALIVE_URL=https://your-render-app.onrender.com/health
ENABLE_LISTENER_WATCHDOG=true
LISTENER_WATCHDOG_INTERVAL_MS=60000
LISTENER_PERIODIC_RESTART_MS=1800000
ENABLE_BUY_FAILSAFE_POLLING=true
BUY_FAILSAFE_POLL_INTERVAL_MS=60000
ENABLE_GROUP_RECOVERY_WATCHDOG=true
GROUP_RECOVERY_INTERVAL_MS=300000
REQUIRE_ADMIN_FOR_BUY_ALERTS=true
ALLOW_SEND_ON_ADMIN_CHECK_ERROR=true
```

Open this URL to check listener health and group recovery status:

`https://your-render-app.onrender.com/api/debug/listeners`

Open this URL to see why a specific coin is or is not posting to each group:

`https://your-render-app.onrender.com/api/debug/delivery/OGRE`

To force a recovery scan manually, POST to `/api/debug/recover-groups` with your `x-bot-secret` header.

4. Optional setup commands:

   ```text
   /setrules Keep it clean, no spam, no scam links.
   /setwelcome Welcome {user} to {chat}!
   /welcome on
   /antilinks on
   ```

For `/warn`, `/mute`, `/kick`, and `/ban`, reply to the user's message with the command. You can also pass a numeric Telegram user id.

Extra quality-of-life commands:

```text
/clean 20
/pin
/slowmode 10
/lock
/unlock
/save ca Contract address: 5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump
/get ca
/filter website Official site: https://ogremode.com/
```

## Helius Free Webhook Setup

Use this path first if you want the free/simple Solana integration.

1. Create a free Helius account:

   `https://dashboard.helius.dev/`

2. Your bot must be running on a public HTTPS URL. Helius cannot call `localhost`.

   Example endpoint:

   `https://your-domain.com/api/helius`

3. In your bot `.env`, add a private auth header value:

   ```env
   HELIUS_AUTH_HEADER=choose-a-private-helius-secret
   SOLANA_RPC_HTTP=https://api.mainnet-beta.solana.com
   ```

4. In the Helius dashboard, create an Enhanced Transaction webhook.

5. Webhook URL:

   `https://your-domain.com/api/helius`

6. Authorization header:

   Use the same value from `HELIUS_AUTH_HEADER`.

7. Transaction types:

   Use `SWAP` if available. Use `ANY` while testing if Helius does not catch the buys you expect.

8. Account addresses:

   Add the token mint/contract address for each coin the bot tracks. For OGRE:

   `5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump`

9. Add the bot to your Telegram channel and run:

   ```text
   /track OGRE
   ```

When Helius sees a matching transaction, it sends it to `/api/helius`. The bot matches the token mint to `data/coins.json`, posts the buy alert, estimates USD value from DexScreener, links the transaction on Solscan, and shows the buyer's SOL balance.

For production, use a paid/stable Solana RPC URL in `SOLANA_RPC_HTTP` instead of the public endpoint.

## Files

- `src/index.js`: main bot and API server
- `src/store.js`: JSON storage
- `src/render.js`: Telegram message formatting
- `data/coins.json`: OGRE and tracked coin settings
- `.env.example`: environment variable template
- `README.md`: project README

## Security

Your Telegram bot token is a password. Do not post it publicly. If you already shared it somewhere public, regenerate it in BotFather.
