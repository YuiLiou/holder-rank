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
  const { stock, lots, statDate, brackets, total, rank, cache, quote } = data;

  lastResultData = data;
  renderCheerBox();

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

const ENCOURAGEMENT_WORDS = [
  "你已經很棒了，繼續前進！",
  "每一次查詢，都是在為未來鋪路",
  "穩穩地走，你正在變得更好",
  "持有本身，就是一種勇氣",
  "你比想像中更靠近目標",
  "今天的你，比昨天更懂投資了",
  "小小的堅持，累積成大大的改變",
  "繼續保持，你正在對的路上",
  "願你的耐心，換來甜美的果實",
  "別小看自己，你正在慢慢變強",
  "你的努力，市場都看在眼裡",
  "一步一腳印，你已經走了很遠",
  "相信自己，你做得到",
  "今天也是充滿希望的一天",
  "你的堅持，值得被看見",
  "慢慢來，你會抵達的",
  "每一份持有，都是對未來的投資",
  "你正在成為更好的自己",
  "別急，你的成果正在路上",
  "你已經比很多人更早開始了，很棒",
  "繼續加油，你的未來很值得期待",
  "今天的努力，會在未來發光",
  "你值得擁有更好的生活",
  "堅持下去，你會感謝現在的自己",
  "你不是一個人，時間會陪著你",
  "你正在做一件很棒的事情",
  "小步前進，也是前進",
  "你的未來，正在被你一點一滴打造",
  "辛苦了，你已經做得很好了",
  "願你今天也充滿力量",
  "你的耐心，會有回報的",
  "繼續累積，你會看到改變",
  "你正在寫下屬於自己的成長故事",
  "別放棄，光就在前面",
  "你已經比昨天更進步一點了",
  "你的每個選擇，都在成就更好的自己",
  "穩紮穩打，你會走得又穩又遠",
  "你值得為自己的堅持鼓掌",
  "今天也要對自己溫柔一點",
  "你正在建立屬於自己的底氣",
  "願你的每一分努力，都有跡可循",
  "你已經走在正確的方向上了",
  "繼續前進，未來的你會感謝現在的你",
  "你的堅持，正在悄悄開花",
  "別忘了，你已經很努力了",
  "你的每一步，都算數",
  "相信時間，也相信自己",
  "你正在為自己的人生負責，很棒",
  "願你所有的努力，都不被辜負",
  "你比自己想像中更有力量",
];

const CLASSIC_QUOTES = [
  "時間在市場裡，比抓時機更重要",
  "複利是世界第八大奇蹟",
  "慢慢致富，也是一種致富",
  "紀律決定你走多遠",
  "耐心是投資人最貴的資產",
  "每一張股票，都是一份耐心的證明",
  "不怕慢，只怕停",
  "長期主義，終將被時間獎賞",
  "股東名冊上，也寫著你的堅持",
  "小額累積，終成大局",
  "投資自己，永遠不嫌晚",
  "看得懂波動，才守得住報酬",
  "定期定額，是給未來的信",
  "本金是種子，時間是陽光",
  "存股如存人品，急不得",
  "市場獎勵耐心，懲罰躁動",
  "你買的不是股票，是時間",
  "穩健，才是真正的快",
  "每一次持有，都是一次選擇相信",
  "財富自由，從第一張股票開始",
  "風雨之後，才看得見複利的樣子",
  "別人恐懼，你的功課要更扎實",
  "不追高、不殺低，是最難的修行",
  "投資是馬拉松，不是短跑",
  "積小勝為大勝",
  "堅持到最後的人，才配得上結果",
  "你今天的持有，是明天的底氣",
  "股東名單很長，走到最後的人不多",
  "不因暴跌恐慌，不因暴漲膨脹",
  "把時間交給對的標的",
  "紀律比天賦更可靠",
  "投資的本質，是相信自己的判斷",
  "越早開始，複利越有耐心陪你",
  "多一張股票，多一份底氣",
  "存下的，終將回來加倍擁抱你",
  "慢慢來，比較快",
  "你的持股，是你價值觀的縮影",
  "不懂就學，學了就做",
  "每一筆買進，都要對得起自己",
  "真正的贏家，都很會等待",
  "波動是常態，離場才是損失",
  "看懂自己，比看懂市場更難",
  "堅持不是苦撐，是相信會更好",
  "你不理財，財不理你",
  "自律的人，最終都活成了自己想要的樣子",
  "小資也能翻身，關鍵是開始",
  "股市教會我們最重要的一課：耐心",
  "每一次逆風，都是練習抗壓的機會",
  "夢想不會消失，除非你自己放棄",
  "你走的每一步，都算數",
  "成功不是偶然，是無數個堅持的日子",
  "沒有白費的努力，只有還沒開花的種子",
  "越努力，越幸運",
  "今天的辛苦，是明天的自由",
  "相信過程，結果不會太差",
  "先苦後甜，是最踏實的路",
  "你的極限，比你想像的更遠",
  "夢想很貴，但值得你去買單",
  "堅持是最樸實無華的天賦",
  "改變，從承認現況開始",
  "每一次跌倒，都是重新出發的機會",
  "習慣決定命運，選擇決定未來",
  "不怕路遠，只怕心不在",
  "做對的事，比把事情做對更重要",
  "有計畫的努力，才不會白費",
  "你比自己想像中更有韌性",
  "自由，是靠一次次選擇累積出來的",
  "越是艱難的時刻，越考驗初心",
  "人生沒有白走的路，每一步都算數",
  "低谷，是為了讓你看清方向",
  "願你成為自己的靠山",
  "不設限的人生，才配得上無限可能",
  "先相信，才能看見",
  "格局決定結局，態度決定高度",
  "你的努力，時間都看得見",
  "所有的積累，都是為了某天的厚積薄發",
  "成長，是一個人最好的底氣",
  "堅持到看不到希望，才是真正的堅持",
  "選對方向，比拚命更重要",
  "每個現在，都是過去努力的結果",
  "不要害怕重新開始",
  "你的節奏，別人不必懂",
  "真正的自由，是選擇的自由",
  "少一點焦慮，多一點行動",
  "把日子過成自己喜歡的樣子",
  "投資自己，是報酬率最高的事",
  "腳踏實地，才走得穩、走得遠",
  "每天進步一點點，累積起來就是巨大差距",
  "拒絕焦慮，專注當下能做的事",
  "你所渴望的，也在靠近你",
  "低調做事，高調成長",
  "願你熬過去的，都成為故事而不是傷疤",
  "當你想放棄時，想想當初為什麼開始",
  "沉住氣，才守得住運氣",
  "把每一天都活成新的開始",
  "堅持過的每一天，都不會辜負你",
  "有耐心的人，運氣都不會太差",
  "你只需要贏過昨天的自己",
  "路遙知馬力，日久見人心，時間也會見證你的努力",
  "願你的努力，配得上你的夢想",
];

// Picked fresh on every query so re-searching (or searching a different
// stock) shows a new combo instead of always the same pair.
function renderCheerBox() {
  const encouragement =
    ENCOURAGEMENT_WORDS[Math.floor(Math.random() * ENCOURAGEMENT_WORDS.length)];
  const quote = CLASSIC_QUOTES[Math.floor(Math.random() * CLASSIC_QUOTES.length)];

  document.getElementById("cheer-encouragement").textContent = encouragement;
  document.getElementById("cheer-quote").textContent = `「${quote}」`;
}
