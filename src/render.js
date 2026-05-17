const OGRE_TELEGRAM = 'https://t.me/ogrecoinonsol';
const OGRE_WEBSITE = 'https://ogremode.com/';
const OGRE_TWITTER = 'https://twitter.com/i/communities/1930265213917425858';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

const number = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4
});

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2
});

const SLIME_BORDER = '━━━━━━━━━━━━━━━━━━━━';

export function renderBuyAlert({ coin, event, trending, primaryCoin, tokenMeta }) {
  const tokenName = tokenMeta?.name || coin.name || coin.symbol;
  const buyer = event.buyer && event.buyer !== 'DEXSCREENER_AGGREGATE' ? shortWallet(event.buyer) : null;
  const tokenAmount = Number(event.tokenAmount ?? 0);
  const tokens = number.format(tokenAmount);
  const usdValue = Number(event.usdValue ?? 0);
  const quoteAmount = event.quoteAmount ? `${number.format(Number(event.quoteAmount))} ${event.quoteSymbol ?? 'SOL'}` : null;
  const position = event.buyerSolBalance != null ? `${formatSigned(Number(event.buyerSolBalance))}%` : null;
  const marketCap = event.marketCap ? money.format(Number(event.marketCap)) : tokenMeta?.marketCapUsd ? money.format(Number(tokenMeta.marketCapUsd)) : null;
  const txLine = event.txUrl ? `<a href="${escapeHtml(event.txUrl)}">Chart</a>` : null;
  const buyLine = coin.buyUrl ? `<a href="${escapeHtml(coin.buyUrl)}">Buy</a>` : null;
  const socialsLine = renderSocials(coin, tokenMeta);

  return [
    SLIME_BORDER,
    `<b>NEW | ${escapeHtml(tokenName)} BUY!</b>`,
    'by @OgreBuyBot',
    '',
    renderBondingCurve(tokenMeta),
    '',
    event.aggregateBuys ? `<b>Detected:</b> ${escapeHtml(event.aggregateBuys)} DEX buy${event.aggregateBuys === 1 ? '' : 's'}` : null,
    quoteAmount ? `<b>SOL</b> ${escapeHtml(quoteAmount.replace(' SOL', ''))}${usdValue > 0 ? ` (${escapeHtml(money.format(usdValue))})` : ''}` : null,
    tokenAmount > 0 ? `<b>${formatTicker(coin.symbol)}</b> ${escapeHtml(tokens)} (${escapeHtml(formatMultiplier(tokenAmount))})` : null,
    event.aggregateVolumeUsd ? `<b>DEX activity:</b> ${escapeHtml(money.format(Number(event.aggregateVolumeUsd)))}` : null,
    position ? `<b>Position:</b> ${escapeHtml(position)} <i>(Wallet)</i>` : null,
    buyer ? `Buyer: <b>${escapeHtml(buyer)}</b>` : null,
    marketCap ? `<b>MCap:</b> ${escapeHtml(marketCap)}` : null,
    socialsLine ? `<b>Socials:</b> ${socialsLine}` : null,
    event.dex ? `<b>DEX:</b> ${escapeHtml(event.dex)}` : null,
    '',
    renderDexPaidLine(event.dex),
    '',
    [txLine, buyLine].filter(Boolean).join(' | '),
    renderAdBlock({ trending, primaryCoin }),
    renderOgreFooter(),
    SLIME_BORDER
  ].filter(Boolean).join('\n');
}

function renderBondingCurve(tokenMeta) {
  const progress = tokenMeta?.bondingProgress == null
    ? tokenMeta?.complete === true ? 100 : null
    : Math.max(0, Math.min(100, Number(tokenMeta.bondingProgress)));
  if (progress == null) return null;

  const totalBlocks = 8;
  const filled = progress >= 100 ? totalBlocks : Math.round((progress / 100) * totalBlocks);
  const empty = Math.max(0, totalBlocks - filled);
  const status = progress >= 100 ? 'BONDED' : 'Bonding Process';

  return [
    `<b>${number.format(progress)}% ${status}</b> ${'🟩'.repeat(filled)}${'⬛'.repeat(empty)}`
  ].join('\n');
}

function renderDexPaidLine(dex) {
  const label = dex ? `DEX PAID | ${dex}` : 'DEX PAID';
  return `<b>[ ${escapeHtml(label)} ]</b>`;
}

function renderSocials(coin, tokenMeta) {
  const links = [];

  if (coin.website) links.push(`<a href="${escapeHtml(coin.website)}">Web</a>`);
  if (tokenMeta?.twitter) links.push(`<a href="${escapeHtml(tokenMeta.twitter)}">X</a>`);
  if (tokenMeta?.telegram) links.push(`<a href="${escapeHtml(tokenMeta.telegram)}">Tg</a>`);

  return links.join(' | ');
}

export function renderAdBlock({ trending, primaryCoin }) {
  const lines = ['', '<b>Top Movers</b>'];

  const ogre = primaryCoin?.symbol?.toUpperCase() === 'OGRE'
    ? primaryCoin
    : { symbol: 'OGRE', buyUrl: 'https://pump.fun/coin/5RAZMWd9RiKfodLPQ73cFk4CMoJzTUsATUoRdDThpump' };
  const ogreLink = ogre.buyUrl ? ` - <a href="${escapeHtml(ogre.buyUrl)}">Buy</a>` : '';
  lines.push(`1. ${formatTicker(ogre.symbol)}${ogreLink}`);

  const items = trending
    .filter((item) => item.symbol.toUpperCase() !== 'OGRE')
    .filter((item, index, list) => list.findIndex((other) => other.symbol.toUpperCase() === item.symbol.toUpperCase()) === index)
    .sort((a, b) => Number(b.volumeUsd ?? 0) - Number(a.volumeUsd ?? 0))
    .slice(0, 3);

  items.forEach((item, index) => {
    const coin = item.coin;
    const link = coin.buyUrl ? ` - <a href="${escapeHtml(coin.buyUrl)}">Buy</a>` : '';
    lines.push(`${index + 2}. ${formatTicker(item.symbol)}${link}`);
  });

  return lines.join('\n');
}

function renderOgreFooter() {
  return [
    '',
    '<b>powered by ogres</b>',
    `<a href="${OGRE_TELEGRAM}">Telegram</a> | <a href="${OGRE_WEBSITE}">Website</a> | <a href="${OGRE_TWITTER}">Twitter</a>`
  ].join('\n');
}

export function renderCoinList(coins) {
  if (coins.length === 0) return 'No coins are registered yet.';

  return coins.map((coin) => {
    const primary = coin.isPrimary ? ' *' : '';
    const channels = (coin.channels ?? []).length;
    return `${formatTicker(coin.symbol)}${primary} - ${coin.name} (${channels} channel${channels === 1 ? '' : 's'})`;
  }).join('\n');
}

export function renderTrendingList(trending, primaryCoin) {
  if (trending.length === 0) {
    return primaryCoin
      ? `No buy volume yet. ${formatTicker(primaryCoin.symbol)} will still rotate as the featured mover.`
      : 'No buy volume yet.';
  }

  return [
    'Top bot coins by 24h volume:',
    '',
    ...trending.map((item, index) => `${index + 1}. ${formatTicker(item.symbol)} - ${money.format(item.volumeUsd)} volume, ${item.buys} buys`)
  ].join('\n');
}

function shortWallet(wallet) {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function formatTicker(symbol) {
  return `$${String(symbol).replace(/^\$+/, '').toUpperCase()}`;
}

function formatMultiplier(amount) {
  if (amount >= 1000) return `${compact.format(amount)}x`;
  return `${number.format(amount)}x`;
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return '0';
  return value > 0 ? `+${number.format(value)}` : number.format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
