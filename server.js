const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// TDCC only publishes a new 股權分散表 once a week, so there is no point
// re-scraping twsthr on every request. Cache each ticker's parsed result
// in memory and reuse it until it goes stale.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 6 * 60 * 60 * 1000; // 6 hours
const distributionCache = new Map(); // stockCode -> { data, fetchedAt }

app.use(express.static(path.join(__dirname, "public")));

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

async function fetchDistribution(stockCode) {
  const url = `https://norway.twsthr.info/StockHolders.aspx?stock=${encodeURIComponent(
    stockCode,
  )}`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      Referer: "https://norway.twsthr.info/",
    },
    timeout: 15000,
  });
  const $ = cheerio.load(res.data);

  const table = $("#details");
  if (table.length === 0) {
    throw new Error("找不到股權分散表，請確認股票代號是否正確");
  }

  // Header row holds the 3 statistics dates (most recent first)
  const dateHeader = table.find("thead tr").eq(1);
  const statDate = dateHeader
    .find("th")
    .eq(1)
    .text()
    .trim()
    .replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");

  const brackets = [];
  let total = null;

  table.find("tbody tr").each((_, row) => {
    const tds = $(row).find("td");
    if (tds.length < 5) return; // spacer/blank rows
    const label = $(tds[1]).text().trim();
    if (!label || label.startsWith("*")) return; // skip cumulative "X張以上" summary rows

    const count = parseNumber($(tds[2]).text());
    const lots = parseNumber($(tds[3]).text());
    const pct = parseNumber($(tds[4]).text());
    if (Number.isNaN(count)) return;

    if (label === "合計") {
      total = { count, lots, pct };
      return;
    }
    brackets.push({ label, count, lots, pct });
  });

  if (!total || brackets.length === 0) {
    throw new Error("解析股權分散表失敗");
  }

  return { statDate, brackets, total };
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
  const rankEstimate = Math.round(superiorCount + peopleAboveInBracket + 1);
  const rankRangeLow = superiorCount + 1;
  const rankRangeHigh = superiorCount + ownBracket.count;

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

app.get("/api/rank", async (req, res) => {
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

    const { statDate, brackets, total, fromCache, cachedAt } =
      await getDistribution(stock, forceRefresh);
    const rank = estimateRank(brackets, total, lots);

    res.json({
      stock,
      lots,
      statDate,
      brackets,
      total,
      rank,
      cache: { fromCache, cachedAt, ttlMs: CACHE_TTL_MS },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "查詢失敗，請稍後再試" });
  }
});

// Manual cache bust for a single ticker, or the whole cache if no stock given.
app.post("/api/cache/clear", express.json(), (req, res) => {
  const stock = String((req.body && req.body.stock) || "").trim().toUpperCase();
  if (stock) {
    distributionCache.delete(stock);
  } else {
    distributionCache.clear();
  }
  res.json({ ok: true, cleared: stock || "all" });
});

app.listen(PORT, () => {
  console.log(`holder-rank server running at http://localhost:${PORT}`);
});
