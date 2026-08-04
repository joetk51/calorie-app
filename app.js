// ---------- ストレージ ----------
const LS_KEYS = {
  entries: 'calorieApp_entries',
  settings: 'calorieApp_settings',
  goals: 'calorieApp_goals',
};

const defaultSettings = { apiKey: '', model: 'gemini-2.5-flash' };
const defaultGoals = { calories: 2000, protein: 100, fat: 60, carb: 250 };

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

let entries = loadJSON(LS_KEYS.entries, []);
let settings = { ...defaultSettings, ...loadJSON(LS_KEYS.settings, {}) };
let goals = { ...defaultGoals, ...loadJSON(LS_KEYS.goals, {}) };

function saveEntries() { saveJSON(LS_KEYS.entries, entries); }
function saveSettings() { saveJSON(LS_KEYS.settings, settings); }
function saveGoals() { saveJSON(LS_KEYS.goals, goals); }

// ---------- ユーティリティ ----------
const $ = (sel) => document.querySelector(sel);

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function toLocalDatetimeInputValue(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fmt1(n) { return Math.round(n * 10) / 10; }

function resizeImage(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- タブ切り替え ----------
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  document.querySelector(`.tab-btn[data-view="${name}"]`).classList.add('active');
  if (name === 'today') renderToday();
  if (name === 'history') renderHistory();
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---------- 記録タブ: 写真＆AI解析 ----------
let analysisImageBase64 = null; // 解析用(大きめ)
let storedThumbnail = null; // 保存用(小さめ)

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const [analysisDataUrl, thumbDataUrl] = await Promise.all([
    resizeImage(file, 800, 0.82),
    resizeImage(file, 160, 0.6),
  ]);

  analysisImageBase64 = analysisDataUrl.split(',')[1];
  storedThumbnail = thumbDataUrl;

  $('#photo-preview').src = analysisDataUrl;
  $('#photo-preview').hidden = false;
  $('#photo-placeholder').hidden = true;
  $('#btn-analyze').disabled = false;
  $('#result-card').hidden = true;
});

const ANALYSIS_PROMPT = `あなたは経験豊富な管理栄養士です。添付された食事の写真を見て、写っている料理・食品をすべて特定し、量を推定したうえで、合計の栄養価を計算してください。
出力は必ず次のJSON形式のみとし、説明文やマークダウンのコードブロックは一切付けないでください。
{
  "foodName": "料理名（日本語、複数ある場合はまとめて短く。例: 鶏の唐揚げ定食）",
  "calories": 合計カロリー(kcal, 数値),
  "protein": たんぱく質の合計(g, 数値),
  "fat": 脂質の合計(g, 数値),
  "carb": 炭水化物の合計(g, 数値),
  "confidence": "high" | "medium" | "low",
  "note": "量や材料の推定根拠を一言で(20文字程度)"
}`;

async function callGemini(base64Image) {
  const { apiKey, model } = settings;
  if (!apiKey) {
    throw new Error('設定タブでGemini APIキーを入力してください。');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{
      parts: [
        { text: ANALYSIS_PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          foodName: { type: 'STRING' },
          calories: { type: 'NUMBER' },
          protein: { type: 'NUMBER' },
          fat: { type: 'NUMBER' },
          carb: { type: 'NUMBER' },
          confidence: { type: 'STRING' },
          note: { type: 'STRING' },
        },
        required: ['foodName', 'calories', 'protein', 'fat', 'carb'],
      },
    },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('通信に失敗しました。ネット接続を確認してください。');
  }

  if (!res.ok) {
    if (res.status === 400) throw new Error('APIキーまたはモデル名が正しくない可能性があります(設定タブを確認)。');
    if (res.status === 429) throw new Error('無料枠のレート上限に達しました。少し待って再試行してください。');
    throw new Error(`APIエラー (HTTP ${res.status})`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate || candidate.finishReason === 'SAFETY') {
    throw new Error('この画像は解析できませんでした。');
  }
  const text = candidate.content?.parts?.map((p) => p.text || '').join('') || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AIの応答を解析できませんでした。もう一度お試しください。');
  }
  return parsed;
}

$('#btn-analyze').addEventListener('click', async () => {
  if (!analysisImageBase64) return;
  const statusEl = $('#analyze-status');
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.textContent = '🔍 AIが写真を解析しています…';
  $('#btn-analyze').disabled = true;

  try {
    const result = await callGemini(analysisImageBase64);
    statusEl.hidden = true;
    openResultForm({
      name: result.foodName || '',
      cal: Number(result.calories) || 0,
      p: Number(result.protein) || 0,
      f: Number(result.fat) || 0,
      c: Number(result.carb) || 0,
      note: result.note || '',
    });
    toast('解析が完了しました。内容を確認して保存してください。');
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = '⚠️ ' + err.message;
  } finally {
    $('#btn-analyze').disabled = false;
  }
});

let baseValues = { cal: 0, p: 0, f: 0, c: 0 };

function openResultForm({ name, cal, p, f, c, note }) {
  baseValues = { cal, p, f, c };
  $('#f-name').value = name;
  $('#f-cal').value = fmt1(cal);
  $('#f-p').value = fmt1(p);
  $('#f-f').value = fmt1(f);
  $('#f-c').value = fmt1(c);
  $('#f-mult').value = 1;
  $('#f-note').value = note || '';
  $('#f-datetime').value = toLocalDatetimeInputValue(new Date());
  $('#result-card').hidden = false;
  $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#f-mult').addEventListener('input', () => {
  const m = parseFloat($('#f-mult').value) || 0;
  $('#f-cal').value = fmt1(baseValues.cal * m);
  $('#f-p').value = fmt1(baseValues.p * m);
  $('#f-f').value = fmt1(baseValues.f * m);
  $('#f-c').value = fmt1(baseValues.c * m);
});

$('#btn-manual').addEventListener('click', () => {
  analysisImageBase64 = null;
  storedThumbnail = null;
  openResultForm({ name: '', cal: 0, p: 0, f: 0, c: 0, note: '' });
});

$('#btn-save').addEventListener('click', () => {
  const name = $('#f-name').value.trim();
  if (!name) { toast('料理名を入力してください'); return; }
  const dt = $('#f-datetime').value ? new Date($('#f-datetime').value) : new Date();

  entries.push({
    id: crypto.randomUUID(),
    dateISO: toLocalDatetimeInputValue(dt).slice(0, 10),
    datetime: dt.toISOString(),
    name,
    calories: parseFloat($('#f-cal').value) || 0,
    protein: parseFloat($('#f-p').value) || 0,
    fat: parseFloat($('#f-f').value) || 0,
    carb: parseFloat($('#f-c').value) || 0,
    note: $('#f-note').value.trim(),
    thumb: storedThumbnail,
  });
  saveEntries();

  // フォームリセット
  $('#result-card').hidden = true;
  $('#photo-preview').hidden = true;
  $('#photo-placeholder').hidden = false;
  $('#photo-input').value = '';
  $('#btn-analyze').disabled = true;
  analysisImageBase64 = null;
  storedThumbnail = null;

  toast('保存しました！');
  switchView('today');
});

// ---------- 今日タブ ----------
function drawDonut(canvas, segments) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, rOuter = Math.min(w, h) / 2 - 4, rInner = rOuter * 0.6;
  const total = segments.reduce((s, seg) => s + seg.value, 0);

  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border');
    ctx.lineWidth = rOuter - rInner;
    ctx.stroke();
    return;
  }

  let start = -Math.PI / 2;
  segments.forEach((seg) => {
    const angle = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, (rOuter + rInner) / 2, start, start + angle);
    ctx.lineWidth = rOuter - rInner;
    ctx.strokeStyle = seg.color;
    ctx.stroke();
    start += angle;
  });
}

function entriesForDate(dateISO) {
  return entries.filter((e) => e.dateISO === dateISO).sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
}

function renderEntryList(container, list, { emptyMsg }) {
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = `<p class="hint">${emptyMsg}</p>`;
    return;
  }
  list.forEach((e) => {
    const item = document.createElement('div');
    item.className = 'entry-item';
    const time = new Date(e.datetime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
      ${e.thumb
        ? `<img class="entry-thumb" src="${e.thumb}" alt="">`
        : `<div class="entry-thumb placeholder">🍽️</div>`}
      <div class="entry-main">
        <div class="entry-name">${escapeHtml(e.name)}</div>
        <div class="entry-sub">${time}・P${fmt1(e.protein)} F${fmt1(e.fat)} C${fmt1(e.carb)}</div>
      </div>
      <div class="entry-cal">${Math.round(e.calories)}kcal</div>
      <button class="entry-del" data-id="${e.id}" aria-label="削除">🗑️</button>
    `;
    container.appendChild(item);
  });
  container.querySelectorAll('.entry-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!confirm('この記録を削除しますか？')) return;
      entries = entries.filter((e) => e.id !== btn.dataset.id);
      saveEntries();
      renderToday();
      renderHistory();
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderToday() {
  const list = entriesForDate(todayISO());
  const totals = list.reduce((acc, e) => {
    acc.cal += e.calories; acc.p += e.protein; acc.f += e.fat; acc.c += e.carb;
    return acc;
  }, { cal: 0, p: 0, f: 0, c: 0 });

  drawDonut($('#chart-pfc'), [
    { value: totals.p * 4, color: '#4f7cff' },
    { value: totals.f * 9, color: '#ffb84f' },
    { value: totals.c * 4, color: '#45c98c' },
  ]);

  $('#today-numbers').innerHTML = `
    <div class="pfc-row"><span><span class="pfc-dot dot-p"></span>たんぱく質</span><strong>${fmt1(totals.p)} g</strong></div>
    <div class="pfc-row"><span><span class="pfc-dot dot-f"></span>脂質</span><strong>${fmt1(totals.f)} g</strong></div>
    <div class="pfc-row"><span><span class="pfc-dot dot-c"></span>炭水化物</span><strong>${fmt1(totals.c)} g</strong></div>
  `;

  const pct = goals.calories > 0 ? Math.min(100, (totals.cal / goals.calories) * 100) : 0;
  $('#cal-progress-fill').style.width = pct + '%';
  const remain = goals.calories - totals.cal;
  $('#cal-progress-text').textContent =
    `${Math.round(totals.cal)} / ${goals.calories} kcal　(${remain >= 0 ? `残り ${Math.round(remain)} kcal` : `${Math.round(-remain)} kcal オーバー`})`;

  renderEntryList($('#today-entries'), list, { emptyMsg: 'まだ記録がありません。「記録」タブから追加しましょう。' });
}

// ---------- 履歴タブ ----------
function renderWeekChart() {
  const canvas = $('#chart-week');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = toLocalDatetimeInputValue(d).slice(0, 10);
    const total = entries.filter((e) => e.dateISO === iso).reduce((s, e) => s + e.calories, 0);
    days.push({ iso, label: d.toLocaleDateString('ja-JP', { weekday: 'short' }), total });
  }

  const max = Math.max(goals.calories, ...days.map((d) => d.total), 1);
  const barW = w / days.length;
  const padding = 22;

  days.forEach((d, i) => {
    const barH = ((h - padding) * d.total) / max;
    const x = i * barW + barW * 0.2;
    const bw = barW * 0.6;
    ctx.fillStyle = d.iso === todayISO() ? '#ff7a45' : '#c9cdd4';
    ctx.fillRect(x, h - padding - barH, bw, barH);
    ctx.fillStyle = '#9a9ca3';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d.label, x + bw / 2, h - 6);
  });
}

function renderHistory() {
  renderWeekChart();
  const picker = $('#history-date-picker');
  if (!picker.value) picker.value = todayISO();
  const list = entriesForDate(picker.value);
  renderEntryList($('#history-entries'), list, { emptyMsg: 'この日の記録はありません。' });
}

$('#history-date-picker').addEventListener('change', renderHistory);

// ---------- 設定タブ ----------
function loadSettingsToForm() {
  $('#s-apikey').value = settings.apiKey;
  $('#s-model').value = settings.model;
  $('#g-cal').value = goals.calories;
  $('#g-p').value = goals.protein;
  $('#g-f').value = goals.fat;
  $('#g-c').value = goals.carb;
}

$('#btn-save-settings').addEventListener('click', () => {
  settings.apiKey = $('#s-apikey').value.trim();
  settings.model = $('#s-model').value.trim() || defaultSettings.model;
  saveSettings();
  toast('設定を保存しました');
});

$('#btn-save-goals').addEventListener('click', () => {
  goals.calories = parseFloat($('#g-cal').value) || defaultGoals.calories;
  goals.protein = parseFloat($('#g-p').value) || defaultGoals.protein;
  goals.fat = parseFloat($('#g-f').value) || defaultGoals.fat;
  goals.carb = parseFloat($('#g-c').value) || defaultGoals.carb;
  saveGoals();
  toast('目標を保存しました');
  renderToday();
});

$('#btn-export').addEventListener('click', () => {
  const payload = { entries, settings: { model: settings.model }, goals, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `calorie-data-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.entries)) throw new Error('invalid');
      const existingIds = new Set(entries.map((x) => x.id));
      const merged = data.entries.filter((x) => !existingIds.has(x.id));
      entries = entries.concat(merged);
      saveEntries();
      if (data.goals) { goals = { ...goals, ...data.goals }; saveGoals(); }
      toast(`${merged.length}件の記録を取り込みました`);
      loadSettingsToForm();
      renderToday();
      renderHistory();
    } catch {
      toast('ファイルの読み込みに失敗しました');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('#btn-clear').addEventListener('click', () => {
  if (!confirm('全ての記録・設定を削除します。元に戻せません。よろしいですか？')) return;
  entries = [];
  settings = { ...defaultSettings };
  goals = { ...defaultGoals };
  saveEntries(); saveSettings(); saveGoals();
  loadSettingsToForm();
  renderToday();
  renderHistory();
  toast('データを削除しました');
});

// ---------- 初期化 ----------
function init() {
  $('#header-date').textContent = new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  loadSettingsToForm();
  renderToday();
}
init();
