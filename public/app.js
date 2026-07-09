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

function renderResult(data, queryStock, queryLots) {
  const { stock, lots, statDate, brackets, total, rank, cache } = data;

  document.getElementById("result-title").textContent =
    `${stock}｜持有 ${fmt(lots)} 張（統計日期：${statDate}）`;

  renderCacheNote(cache, queryStock, queryLots);

  document.getElementById("rank-point").textContent = `第 ${fmt(rank.rankEstimate)} 名`;
  document.getElementById("rank-total").textContent = fmt(rank.N);
  document.getElementById("rank-percentile").textContent =
    `前 ${rank.percentileEstimate.toFixed(2)}%`;

  document.getElementById("rank-range-low").textContent = fmt(rank.rankRangeLow);
  document.getElementById("rank-range-high").textContent = fmt(rank.rankRangeHigh);
  document.getElementById("own-bracket").textContent = rank.ownBracketLabel;

  renderPercentileGauge(rank.percentileEstimate);

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
