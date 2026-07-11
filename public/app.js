const form = document.getElementById("rank-form");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const submitBtn = document.getElementById("submit-btn");

function fmt(n) {
  return Number(n).toLocaleString("zh-TW");
}

function fmtPct(n) {
  return `${n.toFixed(2)}%`;
}

// Mirrors server.js's formatQuoteLineHtml(). Keep in sync if the rendering
// logic changes — server.js uses the same markup for the SSR homepage.
function formatQuoteLineHtml(quote, lots) {
  if (!quote) return "";
  const { price, change, changePct, time } = quote;
  const holdingValue = Math.round(lots * 1000 * price);

  let arrow = "—";
  let cls = "quote-flat";
  if (change > 0) {
    arrow = "▲";
    cls = "quote-up";
  } else if (change < 0) {
    arrow = "▼";
    cls = "quote-down";
  }
  const changeText =
    change !== null && changePct !== null
      ? `${arrow}${Math.abs(change).toFixed(2)}（${change >= 0 ? "+" : "-"}${Math.abs(changePct).toFixed(2)}%）`
      : "";

  return (
    `現價 ${price.toFixed(2)} <span class="${cls}">${changeText}</span>` +
    `｜持股市值約 NT$ ${fmt(holdingValue)}${time ? `（${time}）` : ""}`
  );
}

const stockInput = document.getElementById("stock");
const quickStocksEl = document.getElementById("quick-stocks");

function syncActiveChip() {
  const current = stockInput.value.trim().toUpperCase();
  quickStocksEl.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.stock.toUpperCase() === current);
  });
}

quickStocksEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  stockInput.value = chip.dataset.stock;
  syncActiveChip();
  form.requestSubmit();
});

stockInput.addEventListener("input", syncActiveChip);
syncActiveChip();

async function performQuery(stock, lots, forceRefresh) {
  statusEl.textContent = "查詢中，請稍候...";
  statusEl.className = "loading";
  resultEl.classList.add("hidden");
  submitBtn.disabled = true;

  try {
    const url = `/api/rank?stock=${encodeURIComponent(stock)}&lots=${encodeURIComponent(lots)}${
      forceRefresh ? "&refresh=1" : ""
    }`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "查詢失敗");
    }

    renderResult(data, stock, lots);
    statusEl.textContent = "";
    statusEl.className = "";
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = "";
  } finally {
    submitBtn.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const stock = stockInput.value.trim();
  const lots = document.getElementById("lots").value.trim();
  performQuery(stock, lots, false);
});

let lastResultData = null;

function renderResult(data, queryStock, queryLots) {
  const { stock, lots, statDate, brackets, total, rank, cache, quote, upgrade } = data;

  lastResultData = data;

  document.getElementById("result-title").textContent =
    `${stock}｜持有 ${fmt(lots)} 張（統計日期：${statDate}）`;

  document.getElementById("quote-line").innerHTML = formatQuoteLineHtml(quote, lots);

  renderCacheNote(cache, queryStock, queryLots);

  document.getElementById("rank-point").textContent = `第 ${fmt(rank.rankEstimate)} 名`;
  document.getElementById("rank-total").textContent = fmt(rank.N);
  document.getElementById("rank-percentile").textContent =
    `前 ${rank.percentileEstimate.toFixed(2)}%`;

  document.getElementById("rank-range-low").textContent = fmt(rank.rankRangeLow);
  document.getElementById("rank-range-high").textContent = fmt(rank.rankRangeHigh);
  document.getElementById("own-bracket").textContent = rank.ownBracketLabel;

  renderRevealFigure(rank.percentileEstimate);
  renderPercentileGauge(rank.percentileEstimate);
  renderTierCard(rank, upgrade);

  // Pyramid order: tip (large holders, few people) first, base (small
  // holders, many people) last. Cumulative count accumulates as you walk
  // down from the tip, so it grows layer by layer toward the base — compute
  // it once up front so the chart and the table both use the same numbers.
  let runningTotal = 0;
  const pyramid = [...brackets].reverse().map((b) => {
    runningTotal += b.count;
    return { ...b, cumulative: runningTotal };
  });

  renderPyramidChart(pyramid, rank.ownBracketLabel);

  const tbody = document.querySelector("#bracket-table tbody");
  tbody.innerHTML = "";
  let ownRow = null;
  pyramid.forEach((b) => {
    const tr = document.createElement("tr");
    const isOwn = b.label === rank.ownBracketLabel;
    if (isOwn) {
      tr.className = "highlight-row";
      ownRow = tr;
    }
    const labelCell = isOwn
      ? `${b.label}<span class="you-badge">你在這裡</span>`
      : b.label;
    tr.innerHTML = `
      <td>${labelCell}</td>
      <td>${fmt(b.count)}</td>
      <td>${fmt(b.cumulative)}</td>
      <td>${fmt(b.lots)}</td>
      <td>${b.pct.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });

  const tfoot = document.querySelector("#bracket-table tfoot");
  tfoot.innerHTML = `
    <tr class="total-row">
      <td>合計</td>
      <td>${fmt(total.count)}</td>
      <td>${fmt(runningTotal)}</td>
      <td>${fmt(total.lots)}</td>
      <td>${total.pct.toFixed(2)}</td>
    </tr>
  `;

  resultEl.classList.remove("hidden");

  document
    .getElementById("result-title")
    .scrollIntoView({ block: "start", behavior: "smooth" });
}

// The reveal hero's headline number. Counts up from 0 on each new query so
// the result feels like it "happens" rather than just appearing — skipped
// entirely under prefers-reduced-motion, which jumps straight to the final
// value.
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;

function renderRevealFigure(percentile) {
  const el = document.getElementById("reveal-beat");
  const target = Math.max(0, 100 - percentile);

  if (prefersReducedMotion) {
    el.textContent = target.toFixed(2);
    return;
  }

  const duration = 900;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = (target * eased).toFixed(2);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Position on the 0%-100% spectrum reflects the real percentile, but is
// clamped a few points in from each edge so the marker's value bubble never
// gets clipped by the track's rounded ends for very extreme percentiles.
function renderPercentileGauge(percentile) {
  const marker = document.getElementById("gauge-marker");
  const valueLabel = document.getElementById("gauge-marker-value");
  const clampedPosition = Math.min(97, Math.max(3, percentile));
  marker.style.left = `${clampedPosition}%`;
  valueLabel.textContent = `前 ${percentile.toFixed(2)}%`;
}

// The single editorial element: after showing the computed rank/percentile,
// place the user into a graded tier and hand them an evaluation, a line of
// encouragement, and a fitting master quote — a "system computed your grade"
// verdict instead of the three separate random blurbs this replaces.
// percentile = 前 X%; smaller = rarer/bigger holder. Mirrored in server.js
// (SHAREHOLDER_TIERS / getTier) for the SSR homepage — keep both in sync.
const SHAREHOLDER_TIERS = [
  {
    max: 0.5, grade: "S+", tone: "gold", title: "巔峰巨鯨",
    evaluation: "你站在這檔股票金字塔的最頂端，持股規模超越幾乎所有股東。",
    encouragement: "站得越高，越需要冷靜。真正的考驗不是累積，而是在雜訊中守住判斷。",
    quote: "別人恐懼時我貪婪，別人貪婪時我恐懼。", author: "巴菲特",
  },
  {
    max: 2, grade: "S", tone: "gold", title: "頂級大戶",
    evaluation: "你已進入核心股東圈，是多數人一輩子難以觸及的位置。",
    encouragement: "規模放大了每個決策的重量。持續檢視基本面，別讓部位取代思考。",
    quote: "價格是你付出的，價值是你得到的。", author: "巴菲特",
  },
  {
    max: 5, grade: "A+", tone: "indigo", title: "資深大戶",
    evaluation: "前 5% 的持股水位，是長時間紀律累積的成果，不是短線能達成的。",
    encouragement: "你已經證明了耐心的價值，接下來比的是不被市場情緒帶著走。",
    quote: "時間是卓越企業的朋友，卻是平庸企業的敵人。", author: "巴菲特",
  },
  {
    max: 12, grade: "A", tone: "indigo", title: "資深股東",
    evaluation: "你的持股超越約九成股東，是這檔標的的穩固中堅。",
    encouragement: "中堅的力量在於穩定。別因一時漲跌，動搖已經驗證過的長期判斷。",
    quote: "如果你不打算持有一檔股票十年，那就不要考慮持有它十分鐘。", author: "巴菲特",
  },
  {
    max: 25, grade: "B+", tone: "teal", title: "穩健持有者",
    evaluation: "你已走在前四分之一，超越大多數只在場邊觀望的人。",
    encouragement: "紀律比抓時機更重要。讓時間替你工作，複利不需要你天天盯盤。",
    quote: "股市是把錢從沒有耐心的人手中，轉移到有耐心的人手中的地方。", author: "巴菲特",
  },
  {
    max: 50, grade: "B", tone: "teal", title: "穩定累積者",
    evaluation: "你的持股落在前段班，已經跨過「開始」這個最難的門檻。",
    encouragement: "每一張股票都是對未來的投資，你已經比昨天的自己更靠近目標。",
    quote: "反過來想，總是反過來想。", author: "查理．蒙格",
  },
  {
    max: 80, grade: "C", tone: "sky", title: "成長新星",
    evaluation: "你正在累積的路上，位置還在中後段，但方向是對的。",
    encouragement: "關鍵不是速度，而是能不能持續。小額也能滾出大局。",
    quote: "得到你想要的東西最可靠的方法，是讓自己配得上它。", author: "查理．蒙格",
  },
  {
    max: Infinity, grade: "D", tone: "slate", title: "啟程新手",
    evaluation: "你才剛起步，但已經比從沒開始的人更前面了。",
    encouragement: "每個大戶都曾是新手，今天的第一張，就是未來複利的種子。",
    quote: "投資的第一條規則是絕不虧錢，第二條規則是絕不忘記第一條。", author: "巴菲特",
  },
];

function getTier(percentile) {
  return (
    SHAREHOLDER_TIERS.find((t) => percentile < t.max) ||
    SHAREHOLDER_TIERS[SHAREHOLDER_TIERS.length - 1]
  );
}

// Mirrors server.js's formatTierUpgradeHtml(): pure rendering of the
// numbers server.js's computeTierUpgrade() already worked out (sent as
// `upgrade` in the /api/rank response). Re-deriving extraLots/extraCost
// here would mean duplicating estimateRank's full bracket-search logic in
// the browser just to render one line, so the server does that math once
// and the client only displays it. Keep the markup in sync with server.js.
function formatTierUpgradeHtml(upgrade) {
  if (!upgrade) return "";
  const { nextGrade, nextTitle, extraLots, extraCost } = upgrade;
  const costText = extraCost !== null ? `（約 NT$ ${fmt(extraCost)}）` : "";
  return (
    `再買 <strong>${fmt(extraLots)} 張</strong>${costText}` +
    `即可升級為 <strong>${nextGrade} ${nextTitle}</strong>`
  );
}

// Every grade from D to S+ in climbing order (left = easiest, right =
// hardest), so "current" reads as a position reached rather than a score in
// isolation. SHAREHOLDER_TIERS is ordered hardest-first (S+ at index 0), so
// the ladder reverses it. Mirrors server.js's renderTierLadderHtml() for
// the SSR homepage — keep both in sync.
function renderTierLadder(tierIndex) {
  const rungs = [...SHAREHOLDER_TIERS].reverse(); // index 0 = D ... last = S+
  const currentPos = SHAREHOLDER_TIERS.length - 1 - tierIndex;

  return rungs
    .map((t, i) => {
      const classes = ["rung"];
      if (i < currentPos) classes.push("done");
      else if (i === currentPos) classes.push("current");
      if (i === currentPos + 1) classes.push("is-next");
      return `<span class="${classes.join(" ")}">${t.grade}</span>`;
    })
    .join("");
}

function renderTierCard(rank, upgrade) {
  const tier = getTier(rank.percentileEstimate);
  const tierIndex = SHAREHOLDER_TIERS.indexOf(tier);

  const card = document.getElementById("tier-card");
  card.className = `tier-card tier-card--${tier.tone}`;
  document.getElementById("tier-grade").textContent = tier.grade;
  document.getElementById("tier-name").textContent = tier.title;
  document.getElementById("tier-ladder").innerHTML = renderTierLadder(tierIndex);
  document.getElementById("tier-eval").textContent = tier.evaluation;
  document.getElementById("tier-cheer").textContent = tier.encouragement;
  document.getElementById("tier-upgrade").innerHTML = formatTierUpgradeHtml(upgrade);
  document.getElementById("tier-quote").textContent =
    `「${tier.quote}」－ ${tier.author}`;
}

function renderCacheNote(cache, queryStock, queryLots) {
  const note = document.getElementById("cache-note");
  if (!cache) {
    note.textContent = "";
    return;
  }

  const minutesAgo = Math.max(0, Math.round((Date.now() - cache.cachedAt) / 60000));
  const source = cache.fromCache
    ? `資料來自快取（約 ${minutesAgo} 分鐘前抓取，快取有效 ${Math.round(cache.ttlMs / 3600000)} 小時）`
    : "資料為即時抓取";

  note.innerHTML = `${source}<button type="button" id="force-refresh-btn">重新抓取最新資料</button>`;

  document.getElementById("force-refresh-btn").addEventListener("click", () => {
    performQuery(queryStock, queryLots, true);
  });
}

// Bars use each layer's CUMULATIVE count (people in this bracket + every
// bracket above it toward the tip), not the bracket's own count — that's
// what actually grows monotonically from tip to base and matches the
// "累計人數" column in the table below. A log scale is used for the width
// because cumulative counts still span a few hundred (tip) to a few million
// (base); linear would make everything but the base invisible.
// ---------------------------------------------------------------------
// Share card — renders the current tier verdict as a downloadable /
// shareable PNG via <canvas>. Re-derives the tier from
// SHAREHOLDER_TIERS/getTier off the percentile in the DOM (#rank-percentile)
// rather than parsing the already-formatted grade/quote text, so this works
// identically for the SSR default homepage and a live query result — both
// populate the same #tier-card/#rank-percentile ids.
// ---------------------------------------------------------------------
const TIER_TONE_GRADIENTS = {
  gold: ["#b45309", "#f59e0b"],
  indigo: ["#3730a3", "#6366f1"],
  teal: ["#0f766e", "#14b8a6"],
  sky: ["#0369a1", "#0ea5e9"],
  slate: ["#334155", "#64748b"],
};

const SHARE_FONT =
  '"PingFang TC", "Microsoft JhengHei", -apple-system, BlinkMacSystemFont, sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Wraps by individual character rather than by word — correct for CJK text,
// which has no spaces to break on. Closing punctuation is never allowed to
// start a new line (kinsoku shori) — it's let to slightly overflow the
// previous line instead of dangling alone.
const NO_LINE_START_PUNCTUATION = new Set([
  "，", "。", "、", "！", "？", "」", "』", "）", "：", "；", ")", "]",
]);

function wrapCjkText(ctx, text, maxWidth) {
  const chars = Array.from(text);
  const lines = [];
  let line = "";
  chars.forEach((ch) => {
    const test = line + ch;
    if (line && ctx.measureText(test).width > maxWidth && !NO_LINE_START_PUNCTUATION.has(ch)) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  return lines;
}

function getSharePercentile() {
  const text = document.getElementById("rank-percentile").textContent;
  const match = text.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function buildShareCanvas() {
  const percentile = getSharePercentile();
  const tier = getTier(percentile);
  const tierIndex = SHAREHOLDER_TIERS.indexOf(tier);
  const beatPct = Math.max(0, 100 - percentile).toFixed(2);

  // "0050｜持有 10 張（統計日期：...）" -> "0050｜持有 10 張"; drop the
  // date/example-prefix so the pill stays short enough to never overflow.
  const rawSubtitle = document.getElementById("result-title").textContent.trim();
  const subtitle = rawSubtitle.replace(/^範例：/, "").split("（")[0].trim();

  const [c1, c2] = TIER_TONE_GRADIENTS[tier.tone] || TIER_TONE_GRADIENTS.slate;

  const W = 1080;
  const H = 1350;
  const PAD = 76;
  const maxTextWidth = W - PAD * 2;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Background gradient mirrors .tier-card--<tone> in style.css.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, c1);
  bg.addColorStop(1, c2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "alphabetic";

  // Header: eyebrow + site mark (mirrors .tier-eyebrow)
  ctx.font = `600 26px ${SHARE_FONT}`;
  ctx.globalAlpha = 0.85;
  ctx.textAlign = "left";
  ctx.fillText("大戶等級評定", PAD, 100);
  ctx.textAlign = "right";
  ctx.fillText("holder-rank", W - PAD, 100);
  ctx.globalAlpha = 1;

  // Grade + title (mirrors .tier-grade / .tier-name)
  ctx.textAlign = "center";
  ctx.font = `800 240px ${SHARE_FONT}`;
  ctx.fillText(tier.grade, W / 2, 400);

  ctx.font = `800 58px ${SHARE_FONT}`;
  ctx.fillText(tier.title, W / 2, 468);

  // Subtitle pill (stock + lots)
  ctx.font = `600 26px ${SHARE_FONT}`;
  const pillPaddingX = 22;
  const pillWidth = Math.min(maxTextWidth, ctx.measureText(subtitle).width + pillPaddingX * 2);
  const pillHeight = 48;
  const pillX = W / 2 - pillWidth / 2;
  const pillY = 506;
  ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
  roundRectPath(ctx, pillX, pillY, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(subtitle, W / 2, pillY + 32);

  // Beat statement (mirrors .reveal hero)
  ctx.font = `700 46px ${SHARE_FONT}`;
  ctx.fillText(`持股贏過全體股東 ${beatPct}%`, W / 2, 640);

  // Mini ladder (mirrors .tier-ladder / .rung)
  const rungs = [...SHAREHOLDER_TIERS].reverse();
  const currentPos = SHAREHOLDER_TIERS.length - 1 - tierIndex;
  const ladderY = 682;
  const ladderH = 44;
  const gap = 8;
  const rungW = (maxTextWidth - gap * (rungs.length - 1)) / rungs.length;
  ctx.font = `700 20px ${SHARE_FONT}`;
  rungs.forEach((t, i) => {
    const x = PAD + i * (rungW + gap);
    roundRectPath(ctx, x, ladderY, rungW, ladderH, 8);
    if (i === currentPos) ctx.fillStyle = "#ffffff";
    else if (i < currentPos) ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    else ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
    ctx.fill();
    ctx.fillStyle = i === currentPos ? "#1f2937" : "rgba(255, 255, 255, 0.9)";
    ctx.fillText(t.grade, x + rungW / 2, ladderY + 29);
  });

  // Evaluation + encouragement, wrapped (mirrors .tier-eval / .tier-cheer)
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = 0.96;
  let y = 792;
  ctx.font = `400 32px ${SHARE_FONT}`;
  wrapCjkText(ctx, tier.evaluation, maxTextWidth).forEach((line) => {
    ctx.fillText(line, PAD, y);
    y += 46;
  });

  y += 12;
  ctx.font = `700 32px ${SHARE_FONT}`;
  wrapCjkText(ctx, tier.encouragement, maxTextWidth).forEach((line) => {
    ctx.fillText(line, PAD, y);
    y += 46;
  });
  ctx.globalAlpha = 1;

  // Quote, pinned near the bottom with a divider (mirrors .tier-quote)
  const quoteY = H - 160;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, quoteY - 40);
  ctx.lineTo(W - PAD, quoteY - 40);
  ctx.stroke();

  ctx.font = `italic 400 28px ${SHARE_FONT}`;
  ctx.globalAlpha = 0.92;
  let qy = quoteY;
  wrapCjkText(ctx, `「${tier.quote}」－ ${tier.author}`, maxTextWidth).forEach((line) => {
    ctx.fillText(line, PAD, qy);
    qy += 40;
  });
  ctx.globalAlpha = 1;

  // Footer branding
  ctx.textAlign = "center";
  ctx.font = `600 24px ${SHARE_FONT}`;
  ctx.globalAlpha = 0.85;
  ctx.fillText("holder-rank.onrender.com ｜ 台股股東排行榜", W / 2, H - 50);
  ctx.globalAlpha = 1;

  return canvas;
}

const shareCardBtn = document.getElementById("share-card-btn");
const shareModal = document.getElementById("share-modal");
const shareCardImg = document.getElementById("share-card-img");
const shareDownloadBtn = document.getElementById("share-download-btn");
const shareNativeBtn = document.getElementById("share-native-btn");

let shareCardBlob = null;

function openShareModal() {
  const canvas = buildShareCanvas();
  shareCardImg.src = canvas.toDataURL("image/png");
  shareModal.classList.remove("hidden");
  canvas.toBlob((blob) => {
    shareCardBlob = blob;
  }, "image/png");
}

function closeShareModal() {
  shareModal.classList.add("hidden");
}

shareCardBtn.addEventListener("click", openShareModal);
document.getElementById("share-modal-backdrop").addEventListener("click", closeShareModal);
document.getElementById("share-modal-close").addEventListener("click", closeShareModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !shareModal.classList.contains("hidden")) closeShareModal();
});

shareDownloadBtn.addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = shareCardImg.src;
  link.download = "大戶等級評定.png";
  link.click();
});

// Web Share API (mobile browsers, mainly) lets the user share the image
// straight into another app instead of only downloading it first.
if (navigator.share && navigator.canShare) {
  shareNativeBtn.classList.remove("hidden");
}

shareNativeBtn.addEventListener("click", async () => {
  if (!shareCardBlob) return;
  const file = new File([shareCardBlob], "大戶等級評定.png", { type: "image/png" });
  if (!navigator.canShare({ files: [file] })) return;
  try {
    await navigator.share({
      files: [file],
      title: "大戶等級評定",
      text: "來測測看你的大戶等級！",
    });
  } catch (err) {
    // User cancelled the native share sheet — nothing to do.
  }
});

function renderPyramidChart(pyramid, ownBracketLabel) {
  const container = document.getElementById("pyramid-chart");
  container.innerHTML = "";

  const logCumulative = pyramid.map((b) => Math.log10(Math.max(b.cumulative, 1)));
  const minLog = Math.min(...logCumulative);
  const maxLog = Math.max(...logCumulative);
  const range = maxLog - minLog || 1;
  const MIN_WIDTH_PCT = 6;

  pyramid.forEach((b, i) => {
    const isOwn = b.label === ownBracketLabel;
    const widthPct =
      MIN_WIDTH_PCT + ((logCumulative[i] - minLog) / range) * (100 - MIN_WIDTH_PCT);

    const row = document.createElement("div");
    row.className = "pyramid-row" + (isOwn ? " is-own" : "");
    row.innerHTML = `
      <div class="pyramid-row-label">${b.label}${isOwn ? " 👈" : ""}</div>
      <div class="pyramid-bar-track">
        <div class="pyramid-bar" style="width: ${widthPct.toFixed(1)}%">
          <span>${fmt(b.cumulative)}</span>
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}
