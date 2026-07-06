// スイング動画編集ツール(ブラウザ完結版)
// 動画は端末内で処理され、どこにもアップロードされない。
// PC版(swing_tool.py)のアルゴリズムをJavaScriptに移植したもの。

const $ = id => document.getElementById(id);
const video = $('video');
const overlayCanvas = $('overlayCanvas');

let items = [];
window.DEBUG_ITEMS = items; // 開発検証用
let cur = -1;
let previewPhase = 0; // 0=off, 1=通常, 2=スロー
let analyzing = false;
let audioCtx = null;

// ---------------- ユーティリティ ----------------
function fmt(t) {
  if (t == null) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}
function fmtShort(t) { return t == null ? '--' : t.toFixed(1) + '秒'; }
function setStatus(msg, cls) {
  const el = $('status');
  el.className = 'status ' + (cls || '');
  el.innerHTML = msg;
}
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function seekTo(v, t) {
  return new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}
// シーク後に「新しいフレームが実際に描画された」ことまで保証して待つ。
// スマホのブラウザはseekedの時点ではまだ前のフレームが残っていることがあり、
// そのまま解析すると検出・姿勢推定・ガイド線がすべてズレる
function seekFrame(v, t) {
  return new Promise(res => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked);
      // seeked後に新フレームの描画完了を待つ。先に仕込むと直前の
      // フレーム表示イベントを拾って古いフレームを解析してしまう
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        v.requestVideoFrameCallback(() => finish());
        setTimeout(finish, 120); // rVFCが発火しない環境への保険
      } else {
        setTimeout(finish, 60);
      }
    };
    v.addEventListener('seeked', onSeeked);
    v.currentTime = t;
  });
}
// 解析用の非表示video。DOM上にないとフレーム描画イベントが
// 発火しないブラウザがあるため、画面外に置いて使う
function hiddenVideo(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  v.src = url;
  document.body.appendChild(v);
  return v;
}
function disposeVideo(v) {
  v.removeAttribute('src');
  v.load();
  v.remove();
}
function waitMeta(v) {
  return new Promise((res, rej) => {
    if (v.readyState >= 1) return res();
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error('動画を読み込めませんでした'));
  });
}

// ---------------- ファイル読み込み ----------------
const drop = $('drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
$('file').addEventListener('change', e => {
  if (e.target.files.length) addFiles(e.target.files);
  e.target.value = '';
});

function addFiles(fileList) {
  for (const f of fileList) {
    items.push({
      file: f, url: URL.createObjectURL(f),
      dur: null, vw: 0, vh: 0,
      cellDiffs: null, fpsA: 10,
      candidates: [], candIndex: 0,
      start: null, end: null,
      view: 'auto', lines: null, linesKey: '',
      status: '待機中'
    });
  }
  $('editor').classList.remove('hidden');
  renderQueue();
  if (cur < 0) select(items.length - fileList.length);
  analyzeAll();
}

function renderQueue() {
  const q = $('queue');
  q.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'qrow' + (i === cur ? ' active' : '');
    row.onclick = () => select(i);
    const range = (it.start != null && it.end != null)
      ? `${fmtShort(it.start)} 〜 ${fmtShort(it.end)}` : '';
    row.innerHTML =
      `<span>${i + 1}.</span>` +
      `<span class="qname">${it.file.name}</span>` +
      `<span class="qrange">${range}</span>` +
      `<span class="qstat">${it.status}</span>`;
    const sel = document.createElement('select');
    sel.title = 'スロー再生時のガイド線(撮影方向)';
    [['auto', '線: 自動'], ['front', '線: 正面'], ['back', '線: 後方'],
     ['none', '線なし']].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if ((it.view || 'auto') === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.onclick = e => e.stopPropagation();
    sel.onchange = e => { it.view = e.target.value; it.linesKey = ''; };
    row.appendChild(sel);
    const del = document.createElement('button');
    del.className = 'qdel';
    del.textContent = '✕';
    del.onclick = (e) => { e.stopPropagation(); removeItem(i); };
    row.appendChild(del);
    q.appendChild(row);
  });
}

function removeItem(i) {
  URL.revokeObjectURL(items[i].url);
  items.splice(i, 1);
  if (!items.length) {
    cur = -1;
    $('editor').classList.add('hidden');
    renderQueue();
    return;
  }
  if (cur >= items.length) cur = items.length - 1;
  else if (i < cur) cur -= 1;
  select(cur, true);
}

function select(i, force) {
  if (i === cur && !force) return;
  stopPreview();
  cur = i;
  const it = items[cur];
  if (video.src !== it.url) video.src = it.url;
  refreshTimes();
  $('nextCand').classList.toggle('hidden', it.candidates.length <= 1);
  renderQueue();
  if (it.start != null) video.currentTime = it.start;
}
function refreshTimes() {
  const it = items[cur];
  $('startTime').textContent = fmt(it ? it.start : null);
  $('endTime').textContent = fmt(it ? it.end : null);
}

// ---------------- 動き解析(スイング自動検出) ----------------
// 160x90のグレースケールで0.1秒刻みにフレームを取り、10pxセルごとの
// フレーム差分を計算する(PC版のframe_diffs相当)

async function analyzeAll() {
  if (analyzing) return;
  analyzing = true;
  try {
    for (const it of items) {
      if (it.cellDiffs || it.status.includes('解析中')) continue;
      await analyzeItem(it);
    }
  } finally {
    analyzing = false;
  }
}

async function analyzeItem(it) {
  it.status = '解析中… 0%';
  renderQueue();
  setStatus('<span class="spinner"></span>スイングを解析しています… (' + it.file.name + ')');
  try {
    const v = hiddenVideo(it.url);
    await waitMeta(v);
    it.dur = v.duration;
    it.vw = v.videoWidth; it.vh = v.videoHeight;
    // 長い動画はシーク回数を抑える(検出アルゴリズムはfps可変に対応)
    const W = 160, H = 90;
    const step = it.dur > 120 ? 0.2 : 0.1;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    const gw = 16, gh = 9, cell = 10;
    let prev = null;
    const cellDiffs = [];
    const n = Math.floor(it.dur / step);
    for (let i = 0; i < n; i++) {
      await seekFrame(v, i * step);
      ctx.drawImage(v, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const gray = new Float32Array(W * H);
      for (let p = 0; p < W * H; p++) gray[p] = d[p * 4 + 1]; // 緑チャンネルで十分
      if (prev) {
        const cells = new Float32Array(gw * gh);
        for (let cy = 0; cy < gh; cy++) {
          for (let cx = 0; cx < gw; cx++) {
            let sum = 0;
            for (let y = 0; y < cell; y++) {
              const base = (cy * cell + y) * W + cx * cell;
              for (let x = 0; x < cell; x++) {
                sum += Math.abs(gray[base + x] - prev[base + x]);
              }
            }
            cells[cy * gw + cx] = sum / (cell * cell);
          }
        }
        cellDiffs.push(cells);
      }
      prev = gray;
      if (i % 10 === 0) {
        it.status = `解析中… ${Math.round(i / n * 100)}%`;
        renderQueue();
      }
    }
    disposeVideo(v);
    it.cellDiffs = cellDiffs;
    it.fpsA = 1 / step;

    const impacts = await detectImpacts(it.file);
    const top3 = cellDiffs.map(c => {
      const s = [...c].sort((a, b) => b - a);
      return (s[0] + s[1] + s[2]) / 3;
    });
    it.candidates = detectSwing(top3, it.fpsA, impacts, it.dur);
    it.candIndex = 0;
    it.start = it.candidates[0].start;
    it.end = it.candidates[0].end;
    it.linesKey = '';
    it.status = '✅ 検出済み';
    if (items[cur] === it) {
      refreshTimes();
      video.currentTime = it.start;
      $('nextCand').classList.toggle('hidden', it.candidates.length <= 1);
    }
    setStatus('✅ 検出しました: ' + it.file.name +
      '。一覧のファイル名をタップすると各動画を確認・微調整できます', 'ok');
  } catch (e) {
    it.status = '⚠ 解析失敗(手動設定)';
    setStatus('⚠ ' + it.file.name + ' の自動検出に失敗しました。手動で開始・終了を設定してください (' + e.message + ')', 'err');
  }
  renderQueue();
}

// インパクト音の検出(PC版impact_transients相当)
async function detectImpacts(file) {
  try {
    if (file.size > 200 * 1048576) return []; // 巨大ファイルはメモリ保護のためスキップ
    const buf = await file.arrayBuffer();
    const ab = await getAudioCtx().decodeAudioData(buf);
    const data = ab.getChannelData(0);
    const win = Math.floor(ab.sampleRate / 100); // 10ms
    const n = Math.floor(data.length / win);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * win; j < (i + 1) * win; j++) {
        const a = Math.abs(data[j]);
        if (a > m) m = a;
      }
      env[i] = m * 32767;
    }
    const scored = [];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 50), hi = Math.min(n, i + 50);
      const med = median(env.slice(lo, hi)) + 1.0;
      scored.push([env[i] / med, i * 0.01]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const picks = [];
    for (const [ratio, t] of scored) {
      if (ratio < 10) break;
      if (picks.every(p => Math.abs(t - p) > 0.5)) picks.push(t);
      if (picks.length >= 6) break;
    }
    return picks;
  } catch (e) {
    return []; // 音声なし
  }
}

// スイング区間の推定(PC版detect_swing相当)
function detectSwing(diffs, fps, impacts, total) {
  const n = diffs.length;
  const k = Math.max(1, Math.round(fps * 0.3));
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k + 1); j <= i; j++) { s += diffs[j]; c++; }
    sm[i] = s / c;
  }
  const preQuiet = (i) => {
    const a = Math.max(0, i - Math.round(fps * 3.5));
    const b = Math.max(0, i - Math.round(fps * 1.2));
    if (b - a >= fps * 1.0) return median(Array.from(sm.slice(a, b)));
    return null;
  };
  const quietLen = (i, q) => {
    const thr = Math.max(q * 1.4, q + 0.1 * (sm[i] - q));
    const gap = Math.round(fps * 0.4);
    const j = Math.max(0, i - Math.round(fps * 1.2));
    let p = j, miss = 0;
    while (p > 0 && miss <= gap && j - p < fps * 6) {
      p -= 1;
      miss = sm[p] > thr ? miss + 1 : 0;
    }
    return Math.max(0, (j - p - miss) / fps);
  };
  const expand = (peak, base) => {
    const thr = Math.max(base * 1.25, base + 0.15 * (sm[peak] - base));
    const gap = Math.round(fps * 0.4);
    let i = peak, miss = 0;
    while (i > 0 && miss <= gap && peak - i < fps * 2.5) {
      i -= 1;
      miss = sm[i] < thr ? miss + 1 : 0;
    }
    const si = i + miss;
    i = peak; miss = 0;
    while (i < n - 1 && miss <= gap && i - peak < fps * 2.0) {
      i += 1;
      miss = sm[i] < thr ? miss + 1 : 0;
    }
    const ei = i - miss;
    let start = Math.max(0, si / fps - 0.8);
    let end = Math.min(total, ei / fps + 0.8);
    if (end - start < 1.5) {
      start = Math.max(0, peak / fps - 2.0);
      end = Math.min(total, peak / fps + 1.5);
    }
    return { start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
  };

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => sm[b] - sm[a]);
  const cands = [];
  for (const i of order) {
    if (cands.every(j => Math.abs(i - j) > fps * 0.7)) cands.push(i);
    if (cands.length >= 12) break;
  }
  let scored = [];   // 直前の静止(アドレス)が確認できた通常候補
  const fbScored = []; // 冒頭すぎて静止を確認できない候補(短い動画のみ評価)
  const smSorted = [...sm].sort((a, b) => a - b);
  const smMed = smSorted[Math.floor(smSorted.length / 2)];
  const smQuiet = smSorted[Math.floor(smSorted.length * 0.25)];
  for (const i of cands) {
    const q = preQuiet(i);
    if (q == null) {
      // スマホの短いクリップは撮影開始直後にスイングが始まることが
      // 多いため、冒頭候補も残しておく(静かな時間帯との比で採点)
      if (total < 10) {
        let s = (sm[i] / (smQuiet + 1e-6)) * 2.0;
        if (impacts.some(t => Math.abs(i / fps - t) < 0.5)) s *= 4.0;
        fbScored.push({ score: s, i, q: smQuiet, ql: 0 });
      }
      continue;
    }
    const ql = quietLen(i, q);
    let score = (sm[i] / (q + 1e-6)) * (0.5 + Math.min(ql, 4.0));
    if (impacts.some(t => Math.abs(i / fps - t) < 0.5)) score *= 4.0;
    scored.push({ score, i, q, ql });
  }
  if (!scored.length && !fbScored.length) {
    const i = cands.reduce((a, b) => sm[a] >= sm[b] ? a : b);
    scored = [{ score: 1, i, q: smMed, ql: 99 }];
  }
  const regBest = scored.length ? Math.max(...scored.map(s => s.score)) : 0;
  const fbBest = fbScored.length ? Math.max(...fbScored.map(s => s.score)) : 0;
  let primary, rest;
  if (fbBest > regBest) {
    // 冒頭のスイングが明確に最有力(動画がスイング直前から始まるケース)
    primary = fbScored.reduce((a, b) => a.score >= b.score ? a : b);
    rest = [...scored, ...fbScored.filter(s => s !== primary)]
      .sort((a, b) => b.score - a.score);
  } else {
    const top = scored.filter(s => s.score >= regBest * 0.65 && s.ql >= 2.0);
    primary = top.length ? top.reduce((a, b) => a.i <= b.i ? a : b)
      : scored.reduce((a, b) => a.score >= b.score ? a : b);
    rest = [...scored.filter(s => s.i !== primary.i), ...fbScored]
      .sort((a, b) => b.score - a.score);
  }
  const results = [];
  for (const s of [primary, ...rest]) {
    const r = expand(s.i, s.q);
    if (results.every(x => r.end <= x.start || r.start >= x.end)) results.push(r);
    if (results.length >= 3) break;
  }
  return results;
}

// ---------------- 自動ズーム(PC版motion_bbox / zoom_rect相当) ----------------
function zoomRect(it, start, end, tw, th) {
  if (!it.cellDiffs || !it.cellDiffs.length) return null;
  const fps = it.fpsA, gw = 16, gh = 9;
  const i0 = Math.max(0, Math.floor(start * fps) - 1);
  const i1 = Math.min(it.cellDiffs.length, Math.ceil(end * fps));
  const frames = it.cellDiffs.slice(i0, i1);
  if (frames.length < 4) return null;
  const top3 = frames.map(c => {
    const s = [...c].sort((a, b) => b - a);
    return (s[0] + s[1] + s[2]) / 3;
  });
  const maxT = Math.max(...top3);
  if (maxT <= 0) return null;
  const coverage = frames.map(c => {
    let cnt = 0;
    for (const v of c) if (v > 3.0) cnt++;
    return cnt / c.length;
  });
  const strongIdx = top3.map((t, i) => t >= 0.3 * maxT ? i : -1).filter(i => i >= 0);
  const covStrong = strongIdx.map(i => coverage[i]).sort((a, b) => a - b);
  const thrCov = Math.max(0.30, covStrong[Math.floor(covStrong.length / 2)]);
  const loc = strongIdx.filter(i => coverage[i] <= thrCov);
  if (!loc.length) return null;
  const heat = new Float32Array(gw * gh);
  for (const i of loc) {
    const c = frames[i];
    for (let p = 0; p < c.length; p++) if (c[p] > heat[p]) heat[p] = c[p];
  }
  const restIdx = frames.map((_, i) => i).filter(i => !loc.includes(i));
  if (restIdx.length) {
    const restMean = new Float32Array(gw * gh);
    for (const i of restIdx) {
      const c = frames[i];
      for (let p = 0; p < c.length; p++) restMean[p] += c[p];
    }
    for (let p = 0; p < heat.length; p++) {
      heat[p] = Math.max(0, heat[p] - restMean[p] / restIdx.length * 1.2);
    }
  }
  let peak = 0, peakIdx = 0;
  for (let p = 0; p < heat.length; p++) if (heat[p] > peak) { peak = heat[p]; peakIdx = p; }
  if (peak <= 0) return null;
  // 最熱セルからの塗りつぶし探索
  const active = Array.from(heat, v => v >= peak * 0.15);
  const seen = new Array(gw * gh).fill(false);
  const queue = [peakIdx];
  seen[peakIdx] = true;
  const cellsIn = [];
  while (queue.length) {
    const p = queue.pop();
    cellsIn.push(p);
    const y = Math.floor(p / gw), x = p % gw;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ny = y + dy, nx = x + dx;
        const np = ny * gw + nx;
        if (ny >= 0 && ny < gh && nx >= 0 && nx < gw && !seen[np] && active[np]) {
          seen[np] = true;
          queue.push(np);
        }
      }
    }
  }
  const xs = cellsIn.map(p => p % gw), ys = cellsIn.map(p => Math.floor(p / gw));
  const kx = it.vw / 160, ky = it.vh / 90;
  let bx = Math.min(...xs) * 10 * kx;
  let by = Math.min(...ys) * 10 * ky;
  let bw = (Math.max(...xs) + 1) * 10 * kx - bx;
  let bh = (Math.max(...ys) + 1) * 10 * ky - by;
  const sw = it.vw, sh = it.vh;
  if (bh >= 0.55 * sh) return null; // もともと大きく映っている
  const mx = bw * 0.18, my = bh * 0.18;
  bx = Math.max(0, bx - mx); by = Math.max(0, by - my);
  bw = Math.min(sw - bx, bw + 2 * mx);
  bh = Math.min(sh - by, bh + 2 * my);
  const aspect = tw / th;
  let ch = Math.max(bh, bw / aspect, sh / 3.0);
  ch = Math.min(ch, sh);
  let cw = Math.min(ch * aspect, sw);
  ch = Math.min(ch, cw / aspect);
  if (ch >= 0.9 * sh) return null;
  const cx = Math.max(0, Math.min(bx + bw / 2 - cw / 2, sw - cw));
  const cy = Math.max(0, Math.min(by + bh / 2 - ch / 2, sh - ch));
  return { cw: Math.floor(cw / 2) * 2, ch: Math.floor(ch / 2) * 2,
           cx: Math.floor(cx / 2) * 2, cy: Math.floor(cy / 2) * 2 };
}

// ---------------- 姿勢推定とガイド線 ----------------
let poseLandmarker = null;
async function getPose() {
  if (poseLandmarker) return poseLandmarker;
  setStatus('<span class="spinner"></span>ガイド線用のAIモデルを読み込んでいます…(初回のみ)');
  const vision = await import('./lib/vision_bundle.mjs');
  const fileset = await vision.FilesetResolver.forVisionTasks('./lib/wasm');
  poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: './models/pose_landmarker_full.task' },
    runningMode: 'IMAGE', numPoses: 1
  });
  return poseLandmarker;
}

// 複数の時刻で姿勢推定し、最も確度の高いフレームを採用する。
// 1フレームだけだとボケ・ブレ・シーク不良で線がズレることがあるため
async function poseBest(it, times) {
  const lmk = await getPose();
  const v = hiddenVideo(it.url);
  await waitMeta(v);
  const cvs = document.createElement('canvas');
  cvs.width = it.vw; cvs.height = it.vh;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  let best = null;
  const views = [];
  for (const t of times) {
    await seekFrame(v, Math.max(0, Math.min(it.dur - 0.05, t)));
    ctx.drawImage(v, 0, 0, it.vw, it.vh);
    const res = lmk.detect(cvs);
    if (!res.landmarks || !res.landmarks.length) continue;
    const lm = res.landmarks[0];
    const pts = lm.map(p => [p.x * it.vw, p.y * it.vh, p.z]);
    // 主要ランドマーク(肩・腰・足首)の確度で採点
    const key = [11, 12, 23, 24, 27, 28];
    const vis = Math.min(...key.map(i => lm[i].visibility ?? 1));
    views.push(classifyView(pts));
    if (!best || vis > best.vis) {
      best = { pts, vis, t };
    }
  }
  let ballCtx = null;
  if (best) {
    await seekFrame(v, best.t);
    ctx.drawImage(v, 0, 0, it.vw, it.vh);
    ballCtx = ctx;
  }
  disposeVideo(v);
  if (!best) return { pts: null, ctx: null, view: null };
  // 正面/後方は多数決で決める
  const backVotes = views.filter(x => x === 'back').length;
  const view = backVotes * 2 >= views.length ? 'back' : 'front';
  return { pts: best.pts, ctx: ballCtx, view };
}

function classifyView(pts) {
  const nose = pts[0], ls = pts[11], rs = pts[12];
  const sw = Math.abs(ls[0] - rs[0]) + 1e-6;
  const noseOff = Math.abs(nose[0] - (ls[0] + rs[0]) / 2) / sw;
  const zd = Math.abs(ls[2] - rs[2]);
  return (noseOff >= 0.22 && zd >= 0.06) ? 'back' : 'front';
}

// ボール検出: シャフト先端付近の白い塊(PC版_detect_ball_circle相当)
function detectBallBlob(ctx, near, searchR, rHint, vw, vh) {
  const x0 = Math.max(0, Math.round(near[0] - searchR));
  const y0 = Math.max(0, Math.round(near[1] - searchR));
  const x1 = Math.min(vw, Math.round(near[0] + searchR));
  const y1 = Math.min(vh, Math.round(near[1] + searchR));
  const w = x1 - x0, h = y1 - y0;
  if (w < 12 || h < 12) return null;
  const img = ctx.getImageData(x0, y0, w, h).data;
  const bin = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const g = 0.299 * img[p * 4] + 0.587 * img[p * 4 + 1] + 0.114 * img[p * 4 + 2];
    bin[p] = g > 170 ? 1 : 0;
  }
  const labels = new Int32Array(w * h).fill(-1);
  const areaLo = Math.max(9, rHint * rHint * 0.8);
  const areaHi = rHint * rHint * 15;
  let best = null, bestD = Infinity;
  let label = 0;
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!bin[p0] || labels[p0] >= 0) continue;
    // BFSで連結成分を集める
    const stack = [p0];
    labels[p0] = label;
    const px = [];
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const y = Math.floor(p / w), x = p % w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const np = ny * w + nx;
          if (bin[np] && labels[np] < 0) { labels[np] = label; stack.push(np); }
        }
      }
    }
    label++;
    const area = px.length;
    if (area < areaLo || area > areaHi) continue;
    let minx = w, maxx = 0, miny = h, maxy = 0, sx = 0, sy = 0;
    for (const p of px) {
      const y = Math.floor(p / w), x = p % w;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      sx += x; sy += y;
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const aspect = bw / bh;
    if (aspect < 0.5 || aspect > 2.0) continue;
    // 円形度の代わりに外接矩形に対する充填率で判定(ボール≒0.78)
    const fill = area / (Math.PI * Math.pow(Math.max(bw, bh) / 2, 2));
    if (fill < 0.55 || fill > 1.35) continue;
    const cx = sx / area, cy = sy / area;
    const d = (cx - (near[0] - x0)) ** 2 + (cy - (near[1] - y0)) ** 2;
    if (d < bestD) { bestD = d; best = [x0 + cx, y0 + cy]; }
  }
  return best;
}

// ガイド線の計算(PC版compute_guide_lines相当、線はすべて赤)
function computeGuideLinesJS(view, pts, ctx, vw, vh) {
  const P = i => [pts[i][0], pts[i][1]];
  const nose = P(0);
  const earMid = [(pts[7][0] + pts[8][0]) / 2, (pts[7][1] + pts[8][1]) / 2];
  const shMid = [(pts[11][0] + pts[12][0]) / 2, (pts[11][1] + pts[12][1]) / 2];
  const wrMid = [(pts[15][0] + pts[16][0]) / 2, (pts[15][1] + pts[16][1]) / 2];
  const hipMid = [(pts[23][0] + pts[24][0]) / 2, (pts[23][1] + pts[24][1]) / 2];
  const feet = [P(29), P(30), P(31), P(32)];
  const headH = dist(nose, shMid);
  const torso = dist(shMid, hipMid);
  const groundY = Math.max(...feet.map(p => p[1])) + 0.15 * headH;
  const faceTop = Math.min(...pts.slice(0, 11).map(p => p[1]));
  const personH = Math.max(groundY - faceTop, headH * 4);

  if (view === 'front') {
    const top = faceTop - 0.22 * personH;
    const bot = groundY + 0.06 * personH;
    return [[nose[0], top, nose[0], bot]];
  }
  // 後方ビュー
  const dx = nose[0] >= earMid[0] ? 1 : -1;
  let shaftEnd = [wrMid[0] + dx * 0.58 * (groundY - wrMid[1]), groundY];
  const rHint = Math.max(3, personH * 0.016);
  const searchR = Math.max(60, personH * 0.15);
  const ball = detectBallBlob(ctx, shaftEnd, searchR, rHint, vw, vh) || shaftEnd;

  const lines = [];
  // 1. シャフトの線(ボール→手元、体の少し後ろまで)
  const d1 = dist(ball, wrMid) + 1e-6;
  const u1 = [(wrMid[0] - ball[0]) / d1, (wrMid[1] - ball[1]) / d1];
  const shaftLen = d1 * 1.5;
  lines.push([ball[0], ball[1], ball[0] + u1[0] * shaftLen, ball[1] + u1[1] * shaftLen]);
  // 2. ボール〜首の付け根(頭寄り)の線
  const target = [shMid[0] + (earMid[0] - shMid[0]) * 0.6,
                  shMid[1] + (earMid[1] - shMid[1]) * 0.6];
  const d2 = dist(ball, target) + 1e-6;
  const u2 = [(target[0] - ball[0]) / d2, (target[1] - ball[1]) / d2];
  const neckLen = d2 * 1.15;
  lines.push([ball[0], ball[1], ball[0] + u2[0] * neckLen, ball[1] + u2[1] * neckLen]);
  // 3. 頭の後ろ〜お尻の少し下の線
  const headBack = [earMid[0] + (earMid[0] - nose[0]) * 0.8,
                    earMid[1] + (earMid[1] - nose[1]) * 0.8];
  const hipBack = [hipMid[0] - dx * 0.30 * torso, hipMid[1]];
  const ext = (a, b, k) => [b[0] + (b[0] - a[0]) * k, b[1] + (b[1] - a[1]) * k];
  const p3a = ext(hipBack, headBack, 0.15);
  const p3b = ext(headBack, hipBack, 0.35);
  lines.push([p3a[0], p3a[1], p3b[0], p3b[1]]);
  return lines;
}

// ガイド線を(必要なら)計算してitemにキャッシュする
async function ensureLines(it) {
  if (!$('guides').checked || it.view === 'none' || it.start == null) {
    it.lines = null;
    return;
  }
  const key = `${it.start.toFixed(2)}|${it.view}`;
  if (it.linesKey === key) return;
  try {
    // 区間前半の「最も静止しているフレーム」=アドレスに最も近い瞬間を
    // 姿勢推定に使う(検出区間が多少ズレていても線の位置が狂いにくい)
    let times = [it.start + 0.2, it.start + 0.5, it.start + 0.8];
    if (it.cellDiffs && it.cellDiffs.length) {
      const fps = it.fpsA;
      const i0 = Math.max(0, Math.floor(it.start * fps));
      const i1 = Math.min(it.cellDiffs.length - 1,
        Math.floor(Math.min(it.start + 2.5, it.end) * fps));
      const calm = [];
      for (let i = i0; i <= i1; i++) {
        const s = [...it.cellDiffs[i]].sort((a, b) => b - a);
        calm.push([(s[0] + s[1] + s[2]) / 3, i / fps]);
      }
      calm.sort((a, b) => a[0] - b[0]);
      if (calm.length >= 3) times = calm.slice(0, 3).map(x => x[1]);
    }
    const { pts, ctx, view } = await poseBest(it, times);
    if (!pts) { it.lines = null; it.linesKey = key; it.viewUsed = '人物検出できず'; return; }
    const used = (it.view === 'front' || it.view === 'back') ? it.view : view;
    it.lines = computeGuideLinesJS(used, pts, ctx, it.vw, it.vh);
    it.viewUsed = used === 'front' ? '正面' : '後方';
    it.linesKey = key;
  } catch (e) {
    it.lines = null;
    it.linesKey = key;
    it.viewUsed = '解析失敗';
  }
}

// ---------------- 範囲設定・候補・プレビュー ----------------
$('detect').onclick = async () => {
  const it = items[cur];
  if (!it) return;
  it.cellDiffs = null;
  it.linesKey = '';
  await analyzeItem(it);
};
$('nextCand').onclick = () => {
  const it = items[cur];
  if (!it || it.candidates.length < 2) return;
  it.candIndex = (it.candIndex + 1) % it.candidates.length;
  const c = it.candidates[it.candIndex];
  it.start = c.start; it.end = c.end; it.linesKey = '';
  refreshTimes(); renderQueue();
  video.currentTime = it.start;
  setStatus(`✅ 候補${it.candIndex + 1}/${it.candidates.length}: ` +
    fmt(it.start) + ' 〜 ' + fmt(it.end), 'ok');
};
$('setStart').onclick = () => {
  const it = items[cur];
  if (!it) return;
  it.start = video.currentTime; it.linesKey = '';
  refreshTimes(); renderQueue();
};
$('setEnd').onclick = () => {
  const it = items[cur];
  if (!it) return;
  it.end = video.currentTime;
  refreshTimes(); renderQueue();
};
document.querySelectorAll('[data-adj]').forEach(btn => {
  btn.onclick = () => {
    const it = items[cur];
    if (!it) return;
    const d = parseFloat(btn.dataset.d);
    if (btn.dataset.adj === 'start' && it.start != null) {
      it.start = Math.max(0, it.start + d);
      it.linesKey = '';
      video.currentTime = it.start;
    }
    if (btn.dataset.adj === 'end' && it.end != null) {
      it.end = Math.min(video.duration || Infinity, Math.max(0, it.end + d));
      video.currentTime = it.end;
    }
    refreshTimes(); renderQueue();
  };
});

$('preview').onclick = async () => {
  const it = items[cur];
  if (!it || it.start == null || it.end == null) {
    setStatus('先にスイングの開始・終了位置を設定してください', 'err'); return;
  }
  if (it.end <= it.start) {
    setStatus('終了位置は開始位置より後にしてください', 'err'); return;
  }
  await ensureLines(it);
  setStatus('');
  previewPhase = 1;
  video.playbackRate = 1;
  video.currentTime = it.start;
  showBadge('通常速度');
  clearOverlay();
  video.play();
};
video.addEventListener('timeupdate', () => {
  if (!previewPhase) return;
  const it = items[cur];
  if (!it) return;
  if (video.currentTime >= it.end) {
    if (previewPhase === 1) {
      previewPhase = 2;
      video.currentTime = it.start;
      video.playbackRate = parseFloat($('speed').value);
      showBadge($('speed').value + '倍速');
      drawOverlayLines(it);
    } else {
      stopPreview();
    }
  }
});
video.addEventListener('pause', () => {
  const it = items[cur];
  if (previewPhase && it && video.currentTime < it.end - 0.05) stopPreview();
});
function stopPreview() {
  previewPhase = 0;
  video.pause();
  video.playbackRate = 1;
  hideBadge();
  clearOverlay();
}
function showBadge(t) { $('badge').textContent = t; $('badge').classList.remove('hidden'); }
function hideBadge() { $('badge').classList.add('hidden'); }
function clearOverlay() {
  overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}
function drawOverlayLines(it) {
  overlayCanvas.width = it.vw;
  overlayCanvas.height = it.vh;
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, it.vw, it.vh);
  if (!it.lines) return;
  ctx.strokeStyle = '#ff2d2d';
  ctx.lineWidth = Math.max(3, it.vh / 220);
  ctx.lineCap = 'round';
  for (const [x1, y1, x2, y2] of it.lines) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

// ---------------- 書き出し(MediaRecorder) ----------------
function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  for (const m of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

let exporting = false;
$('export').onclick = async () => {
  if (exporting) return;
  if (!items.length) { setStatus('先に動画を読み込んでください', 'err'); return; }
  for (const it of items) {
    if (it.start == null || it.end == null || it.end <= it.start) {
      setStatus('「' + it.file.name + '」のスイング区間が未設定です', 'err');
      return;
    }
  }
  const mime = pickMime();
  if (!mime) {
    setStatus('❌ このブラウザは動画の書き出しに対応していません。SafariまたはChromeの新しいバージョンをお使いください', 'err');
    return;
  }
  exporting = true;
  $('export').disabled = true;
  $('result').innerHTML = '';
  $('pbar').classList.remove('hidden');
  stopPreview();
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
  try {
    const ac = getAudioCtx();
    await ac.resume();
    const speed = parseFloat($('speed').value);
    const useZoom = $('zoom').checked;
    // ガイド線を先に全動画分計算
    for (const it of items) {
      setStatus('<span class="spinner"></span>ガイド線を計算中… (' + it.file.name + ')');
      await ensureLines(it);
    }
    const tw = Math.floor(items[0].vw / 2) * 2;
    const th = Math.floor(items[0].vh / 2) * 2;
    const cvs = document.createElement('canvas');
    cvs.width = tw; cvs.height = th;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, tw, th);
    const stream = cvs.captureStream(30);
    const recDest = ac.createMediaStreamDestination();
    if (recDest.stream.getAudioTracks().length) {
      stream.addTrack(recDest.stream.getAudioTracks()[0]);
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 12_000_000,
      audioBitsPerSecond: 128_000
    });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { recorder.onstop = res; });
    // 録画開始は最初のフレーム描画時まで遅らせる(冒頭の黒画面を防ぐ)

    const totalSec = items.reduce((s, it) => s + (it.end - it.start) * (1 + 1 / speed), 0);
    let doneSec = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const ev = document.createElement('video');
      ev.playsInline = true; ev.preload = 'auto';
      ev.src = it.url;
      await waitMeta(ev);
      try { ev.preservesPitch = true; } catch (e) {}
      const srcNode = ac.createMediaElementSource(ev);
      srcNode.connect(recDest); // スピーカーには出さず録音のみ
      const rect = useZoom ? zoomRect(it, it.start, it.end, tw, th) : null;
      const cw = rect ? rect.cw : it.vw, chh = rect ? rect.ch : it.vh;
      const cx = rect ? rect.cx : 0, cy = rect ? rect.cy : 0;
      const s = Math.min(tw / cw, th / chh);
      const ox = (tw - cw * s) / 2, oy = (th - chh * s) / 2;
      const mapLine = ([x1, y1, x2, y2]) =>
        [(x1 - cx) * s + ox, (y1 - cy) * s + oy, (x2 - cx) * s + ox, (y2 - cy) * s + oy];

      const playPass = (rate, lines, label) => new Promise((resolve, reject) => {
        const segDur = it.end - it.start;
        seekTo(ev, it.start).then(() => {
          ev.playbackRate = rate;
          let started = false;
          const draw = () => {
            if (ev.currentTime >= it.end || ev.ended) {
              ev.pause();
              if (recorder.state === 'recording') recorder.pause(); // シーク中は録画を止める
              doneSec += segDur / rate;
              return resolve();
            }
            if (!started) {
              started = true;
              if (recorder.state === 'inactive') recorder.start(500);
              else if (recorder.state === 'paused') recorder.resume();
            }
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, tw, th);
            ctx.drawImage(ev, cx, cy, cw, chh, ox, oy, cw * s, chh * s);
            if (lines) {
              ctx.strokeStyle = '#ff2d2d';
              ctx.lineWidth = Math.max(3, th / 220);
              ctx.lineCap = 'round';
              for (const ln of lines) {
                const [a, b, c, d] = mapLine(ln);
                ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
              }
            }
            const prog = (doneSec + Math.max(0, ev.currentTime - it.start) / rate) / totalSec;
            $('pfill').style.width = Math.min(100, prog * 100).toFixed(1) + '%';
            setStatus(`<span class="spinner"></span>書き出し中 (${idx + 1}/${items.length}本目・${label})… 画面を閉じないでください`);
            requestAnimationFrame(draw);
          };
          ev.play().then(() => requestAnimationFrame(draw)).catch(reject);
        });
      });

      await playPass(1, null, '通常速度');
      await playPass(speed, it.lines, 'スロー');
      srcNode.disconnect();
      ev.removeAttribute('src'); ev.load();
    }
    recorder.stop();
    await stopped;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const name = `スイング連結_${stamp}.${ext}`;
    let viewInfo = items
      .filter(it => it.viewUsed)
      .map(it => `${it.file.name} → ${it.viewUsed}`).join(' / ');
    if (viewInfo) viewInfo = `<div class="hint">ガイド線: ${viewInfo}</div>`;
    $('pfill').style.width = '100%';
    setStatus('✅ 書き出しが完了しました!下のボタンから保存してください', 'ok');
    $('result').innerHTML = viewInfo +
      `<a class="dl" href="${url}" download="${name}">⬇ 完成動画を保存 (${(blob.size / 1048576).toFixed(1)}MB)</a>`;
  } catch (e) {
    setStatus('❌ 書き出しに失敗しました: ' + e.message, 'err');
  } finally {
    exporting = false;
    $('export').disabled = false;
    $('pbar').classList.add('hidden');
    try { wakeLock?.release(); } catch (e) {}
  }
};

// 起動時チェック
if (location.protocol === 'file:') {
  setStatus('⚠ このページはWebサーバー経由で開く必要があります(GitHub Pages等)', 'err');
}
