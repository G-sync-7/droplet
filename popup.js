'use strict';

const DEFAULT_SETTINGS = { model: 'auto', reasoning: 'some', powerPlant: false, countContext: true, hidden: false };
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fmtMl(ml) {
  if (ml < 1) return `${ml.toFixed(2)} mL`;
  if (ml < 10) return `${ml.toFixed(1)} mL`;
  if (ml < 1000) return `${Math.round(ml)} mL`;
  return `${(ml / 1000).toFixed(2)} L`;
}

function glasses(ml) {
  if (ml <= 0) return '';
  const g = ml / 250;
  return g < 1 ? `${Math.round(g * 100)}% of a glass` : `${g.toFixed(1)} glasses`;
}

// Totals are stored as energy (Wh); convert with the same rates as content.js.
const COOLING_ML_PER_WH = 0.6;
const POWER_PLANT_ML_PER_WH = 4.5;
const V1_ML_PER_WH = 1.15; // v0.1 stored mL of cooling water at this rate
let powerPlant = false;
let lastTotals = {};

function renderTotals(totals = {}) {
  lastTotals = totals;
  const v2 = totals.v === 2;
  const todayWh = ((totals.byDay || {})[dayKey()] || 0) / (v2 ? 1 : V1_ML_PER_WH);
  const allWh = (Number(v2 ? totals.allTimeWh : totals.allTime) || 0) / (v2 ? 1 : V1_ML_PER_WH);
  const rate = COOLING_ML_PER_WH + (powerPlant ? POWER_PLANT_ML_PER_WH : 0);
  const today = todayWh * rate;
  const all = allWh * rate;
  $('today').textContent = fmtMl(today);
  $('todayCmp').textContent = glasses(today);
  $('all').textContent = fmtMl(all);
  $('allCmp').textContent = glasses(all);
}

async function load() {
  const { settings = {}, totals = {} } = await chrome.storage.local.get(['settings', 'totals']);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  $('model').value = s.model;
  $('reasoning').value = s.reasoning;
  $('countContext').checked = s.countContext;
  $('powerPlant').checked = s.powerPlant;
  $('hidden').checked = s.hidden;
  powerPlant = s.powerPlant;
  renderTotals(totals);
}

function save() {
  powerPlant = $('powerPlant').checked;
  renderTotals(lastTotals);
  chrome.storage.local.set({
    settings: {
      model: $('model').value,
      reasoning: $('reasoning').value,
      countContext: $('countContext').checked,
      powerPlant: $('powerPlant').checked,
      hidden: $('hidden').checked,
    },
  });
}

$('form').addEventListener('change', save);

// Two-step reset instead of confirm(), which is awkward inside a popup.
let armTimer;
$('reset').addEventListener('click', async () => {
  const btn = $('reset');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to reset';
    armTimer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Reset totals'; }, 3000);
    return;
  }
  clearTimeout(armTimer);
  await chrome.storage.local.remove('totals');
  btn.classList.remove('armed');
  btn.textContent = 'Reset totals';
  renderTotals({});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.totals) renderTotals(changes.totals.newValue || {});
});

load();
