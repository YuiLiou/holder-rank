const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Render sits in front of this app as a reverse proxy — without trusting
// it, req.ip would be Render's internal proxy address for every request,
// making the per-IP rate limit below either block everyone together or
// nobody at all.
app.set("trust proxy", true);

// TDCC only publishes a new 股權分散表 once a week, so there is no point
// re-fetching it on every request. Cache each ticker's parsed result in
// memory and reuse it until it goes stale.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 6 * 60 * 60 * 1000; // 6 hours
const distributionCache = new Map(); // stockCode -> { data, fetchedAt }

const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

// The homepage's default example query — shown pre-rendered so both first-
// time visitors and search engine crawlers see real content immediately,
// instead of an empty shell that only fills in after a client-side fetch.
const DEFAULT_EXAMPLE = { stock: "0050", lots: 10 };

// Bracket definitions in the order they appear on norway.twsthr.info, each
// with [lower, upper) bound in 張 (lots) used for within-bracket interpolation.
// A round-number holding (5, 10, 15, ...) sits at the TOP edge of the
// bracket whose upper bound equals that number (matches how twsthr groups them).
const BRACKET_ORDER = [
  { label: "1-999股", lower: 0, upper: 0.999 },
  { label: "1-5張", lower: 0.999, upper: 5 },
  { label: "5-10張", lower: 5, upper: 10 },
  { label: "10-15張", lower: 10, upper: 15 },
  { label: "15-20張", lower: 15, upper: 20 },
  { label: "20-30張", lower: 20, upper: 30 },
  { label: "30-40張", lower: 30, upper: 40 },
  { label: "40-50張", lower: 40, upper: 50 },
  { label: "50-100張", lower: 50, upper: 100 },
  { label: "100-200張", lower: 100, upper: 200 },
  { label: "200-400張", lower: 200, upper: 400 },
  { label: "400-600張", lower: 400, upper: 600 },
  { label: "600-800張", lower: 600, upper: 800 },
  { label: "800-1,000張", lower: 800, upper: 1000 },
  { label: "1,000張以上", lower: 1000, upper: Infinity },
];

function parseNumber(str) {
  return Number(String(str).replace(/,/g, "").trim());
}

const TDCC_URL = "https://www.tdcc.com.tw/portal/zh/smWeb/qryStock";
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
};

// TDCC's query form is CSRF-protected: first GET the form to obtain a
// session cookie, a one-time SYNCHRONIZER_TOKEN, and the latest published
// statistics date, then POST the actual query using that same session.
async function fetchDistribution(stockCode) {
  const formRes = await axios.get(TDCC_URL, {
    headers: BROWSER_HEADERS,
    timeout: 15000,
  });
  const cookie = (formRes.headers["set-cookie"] || [])
    .map((c) => c.split(";")[0])
    .join("; ");
  const $form = cheerio.load(formRes.data);
  const token = $form("#SYNCHRONIZER_TOKEN").attr("value");
  const uri = $form("#SYNCHRONIZER_URI").attr("value");
  const scaDate = $form("#scaDate option").first().attr("value");
  if (!token || !scaDate) {
    throw new Error("無法連線至集保結算所查詢系統，請稍後再試");
  }

  const params = new URLSearchParams({
    SYNCHRONIZER_TOKEN: token,
    SYNCHRONIZER_URI: uri,
    method: "submit",
    firDate: scaDate,
    scaDate,
    sqlMethod: "StockNo",
    stockNo: stockCode,
    stockName: "",
  });

  const res = await axios.post(TDCC_URL, params.toString(), {
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
      Referer: TDCC_URL,
    },
    timeout: 15000,
  });
  const $ = cheerio.load(res.data);

  const table = $("table.table");
  if (table.length === 0 || table.text().includes("查無此資料")) {
    throw new Error("找不到股權分散表，請確認股票代號是否正確");
  }

  const brackets = [];
  let total = null;

  // TDCC reports each bracket in 股 (shares), numbered 序 1-15 in the same
  // order as BRACKET_ORDER, followed by a "差異數調整" rounding row and a
  // "合計" total row. Convert shares -> 張 (lots) to match the existing
  // bracket/rank display, and reuse BRACKET_ORDER's friendlier labels.
  table.find("tr").each((_, row) => {
    const tds = $(row).find("td");
    if (tds.length < 5) return; // header/spacer rows
    const seq = Number($(tds[0]).text().trim());
    const label = $(tds[1]).text().trim();
    const count = parseNumber($(tds[2]).text());
    const shares = parseNumber($(tds[3]).text());
    const pct = parseNumber($(tds[4]).text());

    if (label.startsWith("合")) {
      total = { count, lots: Math.round(shares / 1000), pct };
      return;
    }
    if (!Number.isInteger(seq) || seq < 1 || seq > BRACKET_ORDER.length) return;

    brackets[seq - 1] = {
      label: BRACKET_ORDER[seq - 1].label,
      count,
      lots: Math.round(shares / 1000),
      pct,
    };
  });

  if (!total || brackets.length !== BRACKET_ORDER.length || brackets.includes(undefined)) {
    throw new Error("解析股權分散表失敗");
  }

  const statDate = `${scaDate.slice(0, 4)}-${scaDate.slice(4, 6)}-${scaDate.slice(6, 8)}`;

  return { statDate, brackets, total };
}

const TWSE_QUOTE_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp";

// TWSE's own realtime-quote widget hits this undocumented endpoint. Querying
// both the tse_ (上市) and otc_ (上櫃) prefix for the same code in one call
// and keeping whichever side actually has data auto-detects the market
// without us needing to know it ahead of time.
async function fetchQuote(stockCode) {
  const res = await axios.get(TWSE_QUOTE_URL, {
    params: { ex_ch: `tse_${stockCode}.tw|otc_${stockCode}.tw`, json: 1 },
    headers: BROWSER_HEADERS,
    timeout: 10000,
  });
  const entries = (res.data && res.data.msgArray) || [];
  const match = entries.find((e) => e.z && e.z !== "-");
  if (!match) return null;

  const price = Number(match.z);
  const prevClose = Number(match.y);
  if (!Number.isFinite(price)) return null;

  const change = Number.isFinite(prevClose) ? price - prevClose : null;
  const changePct = change !== null && prevClose ? (change / prevClose) * 100 : null;

  return {
    name: match.n || null,
    market: match.ex || null,
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    change,
    changePct,
    time: match.t || null,
  };
}

// Price moves during the trading day but not fast enough to justify a fresh
// TWSE hit on every single request — a short cache cuts a lot of redundant
// outbound traffic (every /api/rank call AND every homepage load would
// otherwise hit TWSE, even seconds apart or after market close).
const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS) || 30 * 1000; // 30s
const quoteCache = new Map(); // stockCode -> { data, fetchedAt }

// Price is a nice-to-have on top of the rank estimate, not core to it — a
// flaky quote endpoint shouldn't take down the whole /api/rank response.
async function getQuoteSafe(stockCode) {
  const cached = quoteCache.get(stockCode);
  if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
    return cached.data;
  }

  let data = null;
  try {
    data = await fetchQuote(stockCode);
  } catch (err) {
    console.error(`quote fetch failed for ${stockCode}:`, err.message);
  }
  quoteCache.set(stockCode, { data, fetchedAt: Date.now() });
  return data;
}

async function getDistribution(stockCode, forceRefresh) {
  const cached = distributionCache.get(stockCode);
  const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) {
    return { ...cached.data, fromCache: true, cachedAt: cached.fetchedAt };
  }

  const data = await fetchDistribution(stockCode);
  const fetchedAt = Date.now();
  distributionCache.set(stockCode, { data, fetchedAt });
  return { ...data, fromCache: false, cachedAt: fetchedAt };
}

function estimateRank(brackets, total, userLots) {
  // Find which bracket the user's holding sits at the top edge of.
  let bracketIndex = BRACKET_ORDER.findIndex((b) => userLots <= b.upper);
  if (bracketIndex === -1) bracketIndex = BRACKET_ORDER.length - 1;

  const ownBracket = brackets[bracketIndex];
  const bounds = BRACKET_ORDER[bracketIndex];
  if (!ownBracket || !bounds) {
    throw new Error("無法對應到持股級距，請確認張數輸入是否合理");
  }

  const superiorCount = brackets
    .slice(bracketIndex + 1)
    .reduce((sum, b) => sum + b.count, 0);

  // Interpolate WITHIN the bracket so different lot counts in the same
  // bracket (e.g. 9張 vs 10張, both "5-10張") get different ranks, instead
  // of being lumped together.
  let peopleAboveInBracket;
  let method;
  if (bounds.upper === Infinity) {
    // Open-ended top bracket: no upper bound to interpolate against, so
    // approximate the tail with a power-law (Pareto-style) falloff —
    // a common assumption for wealth/shareholding tails. rougher estimate
    // than the closed brackets below.
    peopleAboveInBracket = ownBracket.count * (bounds.lower / userLots);
    method = "pareto-tail";
  } else {
    // Closed bracket: assume holdings are uniformly spread between the
    // bracket's lower and upper bound, and linearly interpolate the count
    // of people above userLots within it.
    const fraction = (bounds.upper - userLots) / (bounds.upper - bounds.lower);
    peopleAboveInBracket = ownBracket.count * fraction;
    method = "linear-interpolation";
  }
  peopleAboveInBracket = Math.min(
    ownBracket.count,
    Math.max(0, peopleAboveInBracket),
  );

  const N = total.count;
  const rankRangeLow = superiorCount + 1;
  const rankRangeHigh = superiorCount + ownBracket.count;
  // Clamp: the interpolated point estimate can round to one past
  // rankRangeHigh at the very edge of the open-ended top bracket (Pareto
  // tail approaches but never quite reaches ownBracket.count), which would
  // otherwise put the point estimate outside the range it's presented with.
  const rankEstimate = Math.min(
    rankRangeHigh,
    Math.max(rankRangeLow, Math.round(superiorCount + peopleAboveInBracket + 1)),
  );

  return {
    N,
    ownBracketLabel: ownBracket.label,
    ownBracketCount: ownBracket.count,
    superiorCount,
    method,
    rankEstimate,
    percentileEstimate: (rankEstimate / N) * 100,
    rankRangeLow,
    rankRangeHigh,
    percentileRangeLow: (rankRangeLow / N) * 100,
    percentileRangeHigh: (rankRangeHigh / N) * 100,
  };
}

// Inverse of estimateRank: given a target percentile, find the minimum lots
// that achieves it. estimateRank's percentileEstimate is monotonically
// non-increasing in lots (more lots -> better rank — verified by the
// "larger holdings never rank worse" test), so binary search over lots
// converges reliably without needing to re-derive a closed-form inverse of
// the piecewise linear-interpolation / Pareto-tail formula.
function findLotsForPercentile(brackets, total, targetPercentile, startLots) {
  const percentileAt = (lots) => estimateRank(brackets, total, lots).percentileEstimate;
  if (percentileAt(startLots) < targetPercentile) return startLots;

  // Can't realistically hold more lots than the stock's total outstanding
  // lots — use that as the search ceiling so an unreachable target (e.g.
  // the stock has too few large holders left to climb past) terminates
  // instead of doubling forever.
  const CEILING = total.lots;
  let lo = startLots;
  let hi = startLots;
  while (percentileAt(hi) >= targetPercentile) {
    if (hi >= CEILING) return null;
    hi = Math.min(CEILING, hi * 2);
  }

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (percentileAt(mid) < targetPercentile) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

function fmt(n) {
  return Number(n).toLocaleString("zh-TW");
}

// Mirrors public/app.js's formatQuoteLineHtml(): builds the "現價 ... ｜持股
// 市值約 ..." line as an HTML string so the same markup can be dropped into
// the SSR template here and into innerHTML client-side. Keep in sync if the
// rendering logic changes.
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

// Mirrors public/app.js's renderPyramidChart(): bars are sized by each
// bracket's CUMULATIVE count (tip -> base) on a log scale, since raw counts
// span a few hundred to a few million. Keep in sync with the client version
// if that rendering logic changes.
function renderPyramidChartHtml(pyramid, ownBracketLabel) {
  const logCumulative = pyramid.map((b) => Math.log10(Math.max(b.cumulative, 1)));
  const minLog = Math.min(...logCumulative);
  const maxLog = Math.max(...logCumulative);
  const range = maxLog - minLog || 1;
  const MIN_WIDTH_PCT = 6;

  return pyramid
    .map((b, i) => {
      const isOwn = b.label === ownBracketLabel;
      const widthPct =
        MIN_WIDTH_PCT + ((logCumulative[i] - minLog) / range) * (100 - MIN_WIDTH_PCT);
      return `
      <div class="pyramid-row${isOwn ? " is-own" : ""}">
        <div class="pyramid-row-label">${b.label}${isOwn ? " 👈" : ""}</div>
        <div class="pyramid-bar-track">
          <div class="pyramid-bar" style="width: ${widthPct.toFixed(1)}%">
            <span>${fmt(b.cumulative)}</span>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

// Mirrors public/app.js's renderResult() table-building logic.
function renderBracketTableHtml(pyramid, total, runningTotal, ownBracketLabel) {
  const rows = pyramid
    .map((b) => {
      const isOwn = b.label === ownBracketLabel;
      const labelCell = isOwn
        ? `${b.label}<span class="you-badge">你在這裡</span>`
        : b.label;
      return `
      <tr${isOwn ? ' class="highlight-row"' : ""}>
        <td>${labelCell}</td>
        <td>${fmt(b.count)}</td>
        <td>${fmt(b.cumulative)}</td>
        <td>${fmt(b.lots)}</td>
        <td>${b.pct.toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  const totalRow = `
    <tr class="total-row">
      <td>合計</td>
      <td>${fmt(total.count)}</td>
      <td>${fmt(runningTotal)}</td>
      <td>${fmt(total.lots)}</td>
      <td>${total.pct.toFixed(2)}</td>
    </tr>`;

  return { rows, totalRow };
}

// Mirrors public/app.js's renderTierLadder(): every grade from D to S+ in
// climbing order (left = easiest, right = hardest), so "current" reads as a
// position reached rather than a score in isolation. SHAREHOLDER_TIERS is
// ordered hardest-first (S+ at index 0), so the ladder reverses it. Keep in
// sync with app.js if the markup or tier list changes.
function renderTierLadderHtml(tierIndex) {
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

// Mirrors public/app.js's formatTierUpgradeHtml(): pure rendering of the
// numbers computeTierUpgrade() already worked out. Keep in sync if the
// markup changes.
function formatTierUpgradeHtml(upgrade) {
  if (!upgrade) return "";
  const { nextGrade, nextTitle, extraLots, extraCost } = upgrade;
  const costText = extraCost !== null ? `（約 NT$ ${fmt(extraCost)}）` : "";
  return (
    `再買 <strong>${fmt(extraLots)} 張</strong>${costText}` +
    `即可升級為 <strong>${nextGrade} ${nextTitle}</strong>`
  );
}

// Mirrors public/app.js's SHAREHOLDER_TIERS / getTier(): after showing the
// computed rank/percentile, place the user into a graded tier with an
// evaluation, encouragement, and a fitting master quote. percentile = 前 X%;
// smaller = rarer/bigger holder. Keep both copies in sync if the tiers change.
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

// "Buy N more lots to reach the next tier" — computed server-side (not
// mirrored in app.js like the rendering-only helpers below) because it
// needs findLotsForPercentile's search over estimateRank, and duplicating
// that bracket math client-side would risk it silently drifting from the
// real ranking logic. The client just displays the resulting numbers.
function computeTierUpgrade(brackets, total, lots, rank, quote) {
  const tierIndex = SHAREHOLDER_TIERS.indexOf(getTier(rank.percentileEstimate));
  if (tierIndex <= 0) return null; // already at the top tier (S+)

  const nextTier = SHAREHOLDER_TIERS[tierIndex - 1];
  const requiredLots = findLotsForPercentile(brackets, total, nextTier.max, lots);
  if (requiredLots === null) return null;

  // Round UP to the nearest 0.1 lot: since percentile is non-increasing in
  // lots, rounding up only makes the target easier to hit, so the displayed
  // number is always guaranteed sufficient (never displays "buy 0 more").
  const extraLots = Math.max(0.1, Math.ceil((requiredLots - lots) * 10) / 10);
  const extraCost = quote ? Math.round(extraLots * 1000 * quote.price) : null;

  return {
    nextGrade: nextTier.grade,
    nextTitle: nextTier.title,
    extraLots,
    extraCost,
  };
}

// Builds the token -> replacement map for the homepage template. `data` is
// the same shape returned by GET /api/rank, or null to render the empty
// (JS-populated-on-query) state — used as a fallback if the example query
// itself fails to fetch.
function buildResultFragments(data) {
  if (!data) {
    return {
      RESULT_HIDDEN_CLASS: "hidden",
      RESULT_TITLE: "",
      QUOTE_LINE: "",
      CACHE_NOTE: "",
      BEAT_PCT: "0.00",
      RANK_POINT: "",
      RANK_TOTAL: "",
      RANK_PERCENTILE: "",
      GAUGE_LEFT: "50",
      GAUGE_VALUE: "",
      RANK_RANGE_LOW: "",
      RANK_RANGE_HIGH: "",
      OWN_BRACKET: "",
      TIER_TONE: "",
      TIER_GRADE: "",
      TIER_TITLE: "",
      TIER_LADDER: "",
      TIER_EVALUATION: "",
      TIER_ENCOURAGEMENT: "",
      TIER_QUOTE: "",
      TIER_UPGRADE_HTML: "",
      PYRAMID_CHART: "",
      BRACKET_ROWS: "",
      TOTAL_ROW: "",
    };
  }

  const { stock, lots, statDate, brackets, total, rank, quote, upgrade } = data;

  let runningTotal = 0;
  const pyramid = [...brackets].reverse().map((b) => {
    runningTotal += b.count;
    return { ...b, cumulative: runningTotal };
  });

  const { rows, totalRow } = renderBracketTableHtml(
    pyramid,
    total,
    runningTotal,
    rank.ownBracketLabel,
  );
  const gaugeLeft = Math.min(97, Math.max(3, rank.percentileEstimate));
  const tier = getTier(rank.percentileEstimate);
  const tierIndex = SHAREHOLDER_TIERS.indexOf(tier);
  const beatPct = Math.max(0, 100 - rank.percentileEstimate);

  return {
    RESULT_HIDDEN_CLASS: "",
    RESULT_TITLE: `範例：${stock}｜持有 ${fmt(lots)} 張（統計日期：${statDate}）`,
    QUOTE_LINE: formatQuoteLineHtml(quote, lots),
    CACHE_NOTE: "資料為即時抓取",
    BEAT_PCT: beatPct.toFixed(2),
    RANK_POINT: `第 ${fmt(rank.rankEstimate)} 名`,
    RANK_TOTAL: fmt(rank.N),
    RANK_PERCENTILE: `前 ${rank.percentileEstimate.toFixed(2)}%`,
    GAUGE_LEFT: gaugeLeft.toFixed(1),
    GAUGE_VALUE: `前 ${rank.percentileEstimate.toFixed(2)}%`,
    RANK_RANGE_LOW: fmt(rank.rankRangeLow),
    RANK_RANGE_HIGH: fmt(rank.rankRangeHigh),
    OWN_BRACKET: rank.ownBracketLabel,
    TIER_TONE: tier.tone,
    TIER_GRADE: tier.grade,
    TIER_TITLE: tier.title,
    TIER_LADDER: renderTierLadderHtml(tierIndex),
    TIER_EVALUATION: tier.evaluation,
    TIER_ENCOURAGEMENT: tier.encouragement,
    TIER_QUOTE: `「${tier.quote}」－ ${tier.author}`,
    TIER_UPGRADE_HTML: formatTierUpgradeHtml(upgrade),
    PYRAMID_CHART: renderPyramidChartHtml(pyramid, rank.ownBracketLabel),
    BRACKET_ROWS: rows,
    TOTAL_ROW: totalRow,
  };
}

function renderIndexHtml(data) {
  const template = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const fragments = buildResultFragments(data);
  return Object.keys(fragments).reduce(
    (html, token) => html.split(`{{${token}}}`).join(fragments[token]),
    template,
  );
}

// Lightweight in-memory per-IP rate limit for the endpoints that trigger
// outbound requests to TDCC/TWSE. Getting the app's one outbound IP
// re-blocked upstream (the exact problem that forced the
// norway.twsthr.info -> TDCC migration) is a bigger risk than a determined
// abuser working around a simple in-memory limiter.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 20;
const rateLimitHits = new Map(); // ip -> { count, windowStart }

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimitHits.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(ip, { count: 1, windowStart: now });
    return next();
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "查詢太頻繁，請稍後再試" });
  }
  next();
}

// Without this, rateLimitHits would grow forever — every distinct IP that
// has ever made a request stays in the map, since entries are only reset
// (not deleted) once their window rolls over.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitHits) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimitHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// Pre-render the homepage with a real default example (0050, 10張) so
// first-time visitors AND search engine crawlers see actual content instead
// of an empty shell that only fills in after a client-side fetch/click.
// Falls back to the plain empty-state template if the example fetch fails,
// so the page still loads even when the upstream data source is down.
app.get(["/", "/index.html"], async (req, res) => {
  try {
    const [{ statDate, brackets, total }, quote] = await Promise.all([
      getDistribution(DEFAULT_EXAMPLE.stock, false),
      getQuoteSafe(DEFAULT_EXAMPLE.stock),
    ]);
    const rank = estimateRank(brackets, total, DEFAULT_EXAMPLE.lots);
    const upgrade = computeTierUpgrade(brackets, total, DEFAULT_EXAMPLE.lots, rank, quote);
    const html = renderIndexHtml({
      stock: DEFAULT_EXAMPLE.stock,
      lots: DEFAULT_EXAMPLE.lots,
      statDate,
      brackets,
      total,
      rank,
      quote,
      upgrade,
    });
    res.type("html").send(html);
  } catch (err) {
    console.error("SSR homepage render failed, serving empty-state fallback:", err.message);
    res.type("html").send(renderIndexHtml(null));
  }
});

app.use(express.static(PUBLIC_DIR));

app.get("/api/rank", rateLimit, async (req, res) => {
  try {
    const stock = String(req.query.stock || "").trim().toUpperCase();
    const lots = Number(req.query.lots);
    const forceRefresh = req.query.refresh === "1";

    if (!stock) {
      return res.status(400).json({ error: "請提供股票代號" });
    }
    if (!Number.isFinite(lots) || lots <= 0) {
      return res.status(400).json({ error: "請提供有效的持股張數" });
    }

    const [{ statDate, brackets, total, fromCache, cachedAt }, quote] = await Promise.all([
      getDistribution(stock, forceRefresh),
      getQuoteSafe(stock),
    ]);
    const rank = estimateRank(brackets, total, lots);
    const upgrade = computeTierUpgrade(brackets, total, lots, rank, quote);

    res.json({
      stock,
      lots,
      statDate,
      brackets,
      total,
      rank,
      quote,
      upgrade,
      cache: { fromCache, cachedAt, ttlMs: CACHE_TTL_MS },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "查詢失敗，請稍後再試" });
  }
});

// Manual cache bust for a single ticker, or the whole cache if no stock
// given. Disabled unless CACHE_CLEAR_TOKEN is set — this endpoint lets
// anyone force a fresh round of TDCC/TWSE requests, so it must not be open
// by default.
app.post("/api/cache/clear", rateLimit, express.json(), (req, res) => {
  const configuredToken = process.env.CACHE_CLEAR_TOKEN;
  if (!configuredToken) {
    return res.status(403).json({ error: "此端點未啟用" });
  }
  const providedToken = req.get("x-cache-clear-token") || req.query.token;
  if (providedToken !== configuredToken) {
    return res.status(401).json({ error: "未授權" });
  }

  const stock = String((req.body && req.body.stock) || "").trim().toUpperCase();
  if (stock) {
    distributionCache.delete(stock);
    quoteCache.delete(stock);
  } else {
    distributionCache.clear();
    quoteCache.clear();
  }
  res.json({ ok: true, cleared: stock || "all" });
});

// Guarded so requiring this file from a test (to reach estimateRank etc.
// without duplicating the ranking logic) doesn't also start a live server.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`holder-rank server running at http://localhost:${PORT}`);
  });
}

module.exports = { estimateRank, BRACKET_ORDER, computeTierUpgrade, getTier };
