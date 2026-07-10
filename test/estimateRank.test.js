const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateRank, computeTierUpgrade, getTier } = require("../server.js");

// Real 0050 distribution snapshot (statDate 2026-07-03) — used as a fixed
// fixture so these tests don't depend on network access or on TDCC's data
// changing week to week.
const FIXTURE_BRACKETS = [
  { label: "1-999股", count: 1409008, lots: 392552, pct: 1.89 },
  { label: "1-5張", count: 1231519, lots: 2792117, pct: 13.45 },
  { label: "5-10張", count: 301316, lots: 2218816, pct: 10.69 },
  { label: "10-15張", count: 120492, lots: 1492329, pct: 7.19 },
  { label: "15-20張", count: 66067, lots: 1168748, pct: 5.63 },
  { label: "20-30張", count: 60633, lots: 1496089, pct: 7.2 },
  { label: "30-40張", count: 29310, lots: 1026254, pct: 4.94 },
  { label: "40-50張", count: 16206, lots: 732834, pct: 3.53 },
  { label: "50-100張", count: 26747, lots: 1838909, pct: 8.86 },
  { label: "100-200張", count: 8625, lots: 1159720, pct: 5.58 },
  { label: "200-400張", count: 2280, lots: 610881, pct: 2.94 },
  { label: "400-600張", count: 413, lots: 199180, pct: 0.95 },
  { label: "600-800張", count: 137, lots: 94754, pct: 0.45 },
  { label: "800-1,000張", count: 64, lots: 58055, pct: 0.27 },
  { label: "1,000張以上", count: 246, lots: 5473294, pct: 26.37 },
];
const FIXTURE_TOTAL = { count: 3273063, lots: 20754500, pct: 100 };

test("holding of exactly 1張 lands in 1-5張, not 1-999股 (regression)", () => {
  const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 1);
  assert.equal(rank.ownBracketLabel, "1-5張");
});

test("holding just under 1張 (fractional shares) lands in 1-999股", () => {
  const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 0.5);
  assert.equal(rank.ownBracketLabel, "1-999股");
});

test("round-number holdings sit at the top edge of the lower bracket", () => {
  assert.equal(estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 5).ownBracketLabel, "1-5張");
  assert.equal(estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 10).ownBracketLabel, "5-10張");
  assert.equal(
    estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 1000).ownBracketLabel,
    "800-1,000張",
  );
});

test("rankEstimate never falls outside its own [rankRangeLow, rankRangeHigh] (regression, seen at 1001張)", () => {
  for (const lots of [0.5, 1, 5, 9, 10, 15, 999, 1000, 1001, 5000, 999999]) {
    const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots);
    assert.ok(
      rank.rankEstimate >= rank.rankRangeLow && rank.rankEstimate <= rank.rankRangeHigh,
      `lots=${lots}: rankEstimate ${rank.rankEstimate} outside [${rank.rankRangeLow}, ${rank.rankRangeHigh}]`,
    );
  }
});

test("rank and percentile always stay within valid bounds", () => {
  for (const lots of [0.001, 0.5, 1, 2, 5, 10, 50, 100, 1000, 1001, 10000, 999999]) {
    const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots);
    assert.ok(rank.rankEstimate >= 1 && rank.rankEstimate <= rank.N);
    assert.ok(rank.percentileEstimate > 0 && rank.percentileEstimate <= 100);
  }
});

test("larger holdings never rank worse than smaller holdings", () => {
  const lotsList = [0.5, 1, 5, 10, 20, 50, 100, 500, 1000, 2000];
  let prevRank = Infinity;
  for (const lots of lotsList) {
    const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots).rankEstimate;
    assert.ok(rank <= prevRank, `lots=${lots}: rank ${rank} should be <= previous ${prevRank}`);
    prevRank = rank;
  }
});

test("computeTierUpgrade returns null once already at the top tier (S+)", () => {
  const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, 5000);
  assert.equal(getTier(rank.percentileEstimate).grade, "S+");
  const upgrade = computeTierUpgrade(FIXTURE_BRACKETS, FIXTURE_TOTAL, 5000, rank, null);
  assert.equal(upgrade, null);
});

test("computeTierUpgrade's suggested extra lots actually cross into the next tier", () => {
  for (const lots of [1, 5, 10, 20, 50, 200, 800]) {
    const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots);
    const currentTier = getTier(rank.percentileEstimate);
    const upgrade = computeTierUpgrade(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots, rank, null);
    if (!upgrade) continue; // already at the top tier

    const upgradedRank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots + upgrade.extraLots);
    const upgradedTier = getTier(upgradedRank.percentileEstimate);
    assert.equal(
      upgradedTier.grade,
      upgrade.nextGrade,
      `lots=${lots}: buying ${upgrade.extraLots} more should land in tier ${upgrade.nextGrade}, got ${upgradedTier.grade}`,
    );
    assert.notEqual(upgradedTier.grade, currentTier.grade);
  }
});

test("computeTierUpgrade's extra lots is the rounded-up minimum (one tick less falls short)", () => {
  const lots = 20;
  const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots);
  const upgrade = computeTierUpgrade(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots, rank, null);
  assert.ok(upgrade, "expected an upgrade to be available at 20張 for the 0050 fixture");

  const oneTickLess = Math.max(0, upgrade.extraLots - 0.1);
  const shortRank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots + oneTickLess);
  assert.notEqual(getTier(shortRank.percentileEstimate).grade, upgrade.nextGrade);
});

test("computeTierUpgrade includes an NT$ cost estimate when a quote is available", () => {
  const lots = 20;
  const rank = estimateRank(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots);
  const upgrade = computeTierUpgrade(FIXTURE_BRACKETS, FIXTURE_TOTAL, lots, rank, { price: 190 });
  assert.equal(upgrade.extraCost, Math.round(upgrade.extraLots * 1000 * 190));
});
