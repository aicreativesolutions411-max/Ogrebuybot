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
    `<b>NEW | ${escapeHtml(tokenName)} BUY!</b>`,
    `by @MajorBuyBot`,
    '',
    renderBondingCurve(tokenMeta),
    '',
    event.aggregateBuys ? `<b>Detected:</b> ${escapeHtml(event.aggregateBuys)} DEX buy${event.aggregateBuys === 1 ? '' : 's'}` : null,
    quoteAmount ? `<b>SOL</b> ${escapeHtml(quoteAmount.replace(' SOL', ''))}${usdValue > 0 ? ` (${escapeHtml(money.format(usdValue))})` : ''}` : null,
    tokenAmount > 0 ? `<b>${escapeHtml(coin.symbol)}</b> ${escapeHtml(tokens)} (${escapeHtml(formatMultiplier(tokenAmount))})` : null,
    event.aggregateVolumeUsd ? `<b>DEX volume:</b> ${escapeHtml(money.format(Number(event.aggregateVolumeUsd)))}` : null,
    position ? `<b>Position:</b> ${escapeHtml(position)} <i>(Wallet)</i>` : null,
    buyer ? `Buyer: <b>${escapeHtml(buyer)}</b>` : null,
    marketCap ? `<b>MCap:</b> ${escapeHtml(marketCap)}` : null,
    socialsLine ? `<b>Socials:</b> ${socialsLine}` : null,
    event.dex ? `<b>DEX:</b> ${escapeHtml(event.dex)}` : null,
    '',
    renderDexPaidLine(),
    '',
    [txLine, renderVoteLink(), buyLine].filter(Boolean).join(' | '),
    renderAdBlock({ trending, currentSymbol: coin.symbol, primaryCoin })
  ].filter(Boolean).join('\n');
}

function renderBondingCurve(tokenMeta) {
  if (!tokenMeta || tokenMeta.complete === true || tokenMeta.bondingProgress == null) return null;

  const progress = Math.max(0, Math.min(100, Number(tokenMeta.bondingProgress)));
  const totalBlocks = 20;
  const filled = Math.round((progress / 100) * totalBlocks);
  const empty = totalBlocks - filled;

  return [
    `<b>${number.format(progress)}% Bonding Process</b>`,
    `<code>${'▓'.repeat(filled)}${'░'.repeat(empty)}</code>`
  ].join('\n');
}

function renderDexPaidLine() {
  return '<b>[ DEX PAID ]</b>';
}

function renderVoteLink() {
  return '<a href="https://t.me/MajorBuyBot">Vote</a>';
}

function renderSocials(coin, tokenMeta) {
  const links = [];

  if (coin.website) links.push(`<a href="${escapeHtml(coin.website)}">Web</a>`);
  if (tokenMeta?.twitter) links.push(`<a href="${escapeHtml(tokenMeta.twitter)}">X</a>`);
  if (tokenMeta?.telegram) links.push(`<a href="${escapeHtml(tokenMeta.telegram)}">Tg</a>`);

  return links.join(' | ');
}

export function renderAdBlock({ trending, currentSymbol, primaryCoin }) {
  const lines = ['', '<b>SOL LIVE TRENDING</b>'];
  const current = currentSymbol.toUpperCase();
  const primary = primaryCoin?.symbol?.toUpperCase();

  if (primaryCoin) {
    const primaryLink = primaryCoin.buyUrl ? ` - <a href="${escapeHtml(primaryCoin.buyUrl)}">Buy</a>` : '';
    const label = primary === current ? 'Featured now' : 'Rotating ad';
    lines.push(`${label}: $${escapeHtml(primaryCoin.symbol)}${primaryLink}`);
  }

  const items = trending
    .filter((item) => item.symbol !== primary)
    .slice(0, 4);

  for (const item of items) {
    const coin = item.coin;
    const link = coin.buyUrl ? ` - <a href="${escapeHtml(coin.buyUrl)}">Buy</a>` : '';
    lines.push(`$${escapeHtml(item.symbol)}: ${money.format(item.volumeUsd)} volume, ${item.buys} buys${link}`);
  }

  return lines.join('\n');
}

export function renderCoinList(coins) {
  if (coins.length === 0) return 'No coins are registered yet.';

  return coins.map((coin) => {
    const primary = coin.isPrimary ? ' *' : '';
    const channels = (coin.channels ?? []).length;
    return `$${coin.symbol}${primary} - ${coin.name} (${channels} channel${channels === 1 ? '' : 's'})`;
  }).join('\n');
}

export function renderTrendingList(trending, primaryCoin) {
  if (trending.length === 0) {
    return primaryCoin
      ? `No buy volume yet. $${primaryCoin.symbol} will still rotate as the featured ad.`
      : 'No buy volume yet.';
  }

  return [
    'Top bot coins by 24h volume:',
    '',
    ...trending.map((item, index) => `${index + 1}. $${item.symbol} - ${money.format(item.volumeUsd)} volume, ${item.buys} buys`)
  ].join('\n');
}

function shortWallet(wallet) {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
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
