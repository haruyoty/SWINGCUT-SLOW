// スイング動画編集ツール(ブラウザ完結版)
// 動画は端末内で処理され、どこにもアップロードされない。
// PC版(swing_tool.py)のアルゴリズムをJavaScriptに移植したもの。

const $ = id => document.getElementById(id);
const video = $('video');
const overlayCanvas = $('overlayCanvas');

let items = [];
window.DEBUG_ITEMS = items; // 開発検証用
window.DEBUG_FN = null;     // 開発検証用(下部で設定)
let cur = -1;
let previewPhase = 0; // 0=off, 1=通常, 2=スロー
let analyzing = false;
let audioCtx = null;
let exportVideo = null;   // 書き出し用に使い回すvideo要素
let exportSrcNode = null; // その音声ノード(要素につき1回しか作れない)

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
    let hard = null;
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(hard);
      res();
    };
    v.addEventListener('seeked', done);
    hard = setTimeout(done, 2500); // 発火しない環境でも固まらない保険
    v.currentTime = Math.abs(v.currentTime - t) < 0.001 ? t + 0.013 : t;
  });
}
// シーク後に「新しいフレームが実際に描画された」ことまで保証して待つ。
// スマホのブラウザはseekedの時点ではまだ前のフレームが残っていることがあり、
// そのまま解析すると検出・姿勢推定・ガイド線がすべてズレる
function seekFrame(v, t) {
  return new Promise(res => {
    let done = false;
    let hardTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      v.removeEventListener('seeked', onSeeked);
      res();
    };
    const onSeeked = () => {
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
    // どんな状況でも処理が止まらないための最終保険
    hardTimer = setTimeout(finish, 2500);
    // 現在位置と同じ時刻へのシークはseekedが発火しないことがあるため
    // ごくわずかにずらす
    v.currentTime = Math.abs(v.currentTime - t) < 0.001 ? t + 0.013 : t;
  });
}
// 解析用の非表示video。DOM上にないとフレーム描画イベントが
// 発火しないブラウザがあるため、画面外に置いて使う
function hiddenVideo(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  // 画面外(-9999px)に置くとiOSが描画を止めて古いフレームを返すため、
  // 画面内の見えない2pxとして配置する
  v.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
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
    let poll = null, hard = null;
    const ok = () => { clearInterval(poll); clearTimeout(hard); res(); };
    const ng = () => { clearInterval(poll); clearTimeout(hard); rej(new Error('動画を読み込めませんでした')); };
    v.onloadedmetadata = ok;
    v.onerror = ng;
    poll = setInterval(() => {
      if (v.readyState >= 1) ok();
      else if (v.error) ng();
    }, 250);
    hard = setTimeout(ng, 12000);
  });
}
// 使い回すvideo要素に新しい動画を読み込む(前の動画のreadyStateに
// 惑わされないよう、イベントを張ってからsrcを差し替える)。
// イベントが発火しない環境向けに状態ポーリングとタイムアウトの保険付き
function loadInto(v, url) {
  return new Promise((res, rej) => {
    let poll = null, hard = null;
    const cleanup = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onErr);
      clearInterval(poll);
      clearTimeout(hard);
    };
    const onMeta = () => { cleanup(); res(); };
    const onErr = () => { cleanup(); rej(new Error('動画を読み込めませんでした')); };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
    v.src = url;
    v.load();
    poll = setInterval(() => {
      if (v.readyState >= 1 && v.videoWidth > 0) onMeta();
      else if (v.error) onErr();
    }, 250);
    hard = setTimeout(onErr, 8000);
  });
}

// ---------------- 状態の自動保存・復元 ----------------
// スマホは他のアプリに切り替えるとページを破棄することがあるため、
// 動画と解析結果を端末内(IndexedDB)に保存し、再読み込み時に復元する
function dbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('swingtool', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('session');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const data = items.map(it => ({
        file: it.file, dur: it.dur, vw: it.vw, vh: it.vh,
        cellDiffs: it.cellDiffs, fpsA: it.fpsA,
        candidates: it.candidates, candIndex: it.candIndex,
        start: it.start, end: it.end, view: it.view,
        ballManual: it.ballManual, lines: it.lines, linesKey: it.linesKey,
        linesEdited: it.linesEdited || false,
        posePts: it.posePts || null, poseUsed: it.poseUsed || null,
        viewUsed: it.viewUsed || null,
        comments: it.comments || []
      }));
      const db = await dbOpen();
      const tx = db.transaction('session', 'readwrite');
      if (data.length) tx.objectStore('session').put(data, 'items');
      else tx.objectStore('session').delete('items');
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (e) { /* 容量不足などは黙って諦める(動作には影響しない) */ }
  }, 600);
}
async function restoreSession() {
  try {
    const db = await dbOpen();
    const tx = db.transaction('session', 'readonly');
    const req = tx.objectStore('session').get('items');
    const data = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    if (!data || !data.length) return;
    for (const d of data) {
      items.push({
        ...d,
        url: URL.createObjectURL(d.file),
        status: d.cellDiffs ? '✅ 検出済み' : '待機中'
      });
    }
    $('editor').classList.remove('hidden');
    renderQueue();
    select(0, true);
    setStatus('✅ 前回の動画を復元しました(不要な場合は一覧の✕で削除できます)', 'ok');
    analyzeAll(); // 解析が終わっていないものがあれば続きから
  } catch (e) { /* 復元失敗時は普通に空の状態で開始 */ }
}

// ---------------- タイトル画面(オープニング) ----------------
// 冒頭に画像+テキストを4秒間表示する。使うかどうかはチェックボックスで選択
let introImage = null; // 選択された画像ファイル
const INTRO_SEC = 4;
function introEnabled() {
  return $('introOn').checked && (introImage || $('introText').value.trim());
}
let introSaveTimer = null;
function saveIntro() {
  clearTimeout(introSaveTimer);
  introSaveTimer = setTimeout(async () => {
    try {
      const db = await dbOpen();
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put({
        on: $('introOn').checked,
        text: $('introText').value,
        color: $('introColor').value,
        anim: $('introAnim').value,
        outline: $('introOutline').checked,
        outlineColor: $('introOutlineColor').value,
        image: introImage
      }, 'intro');
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      db.close();
    } catch (e) { /* 保存失敗は動作に影響しない */ }
  }, 600);
}
function setIntroImage(f) {
  introImage = f || null;
  const t = $('introThumb');
  if (introImage) {
    t.src = URL.createObjectURL(introImage);
    t.classList.remove('hidden');
    $('introPick').textContent = '🖼 画像を変更';
  } else {
    t.classList.add('hidden');
    $('introPick').textContent = '🖼 画像を選択';
  }
}
$('introOn').addEventListener('change', () => {
  $('introRow').classList.toggle('hidden', !$('introOn').checked);
  saveIntro();
});
$('introPick').onclick = () => $('introFile').click();
$('introFile').addEventListener('change', e => {
  if (e.target.files.length) { setIntroImage(e.target.files[0]); saveIntro(); }
  e.target.value = '';
});
$('introText').addEventListener('input', saveIntro);
$('introColor').addEventListener('input', saveIntro);
$('introAnim').addEventListener('change', saveIntro);
$('introOutline').addEventListener('change', saveIntro);
$('introOutlineColor').addEventListener('input', saveIntro);
async function restoreIntro() {
  try {
    const db = await dbOpen();
    const tx = db.transaction('session', 'readonly');
    const req = tx.objectStore('session').get('intro');
    const d = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    db.close();
    if (!d) return;
    $('introOn').checked = !!d.on;
    $('introRow').classList.toggle('hidden', !d.on);
    $('introText').value = d.text || '';
    $('introColor').value = d.color || '#ffffff';
    $('introAnim').value = d.anim || 'fade';
    $('introOutline').checked = !!d.outline;
    $('introOutlineColor').value = d.outlineColor || '#000000';
    if (d.image) setIntroImage(d.image);
  } catch (e) { /* 復元失敗時は初期状態で開始 */ }
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
      ballManual: null,
      comments: [],
      status: '待機中'
    });
  }
  $('editor').classList.remove('hidden');
  renderQueue();
  if (cur < 0) select(items.length - fileList.length);
  saveSession();
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
    sel.onchange = e => { it.view = e.target.value; it.linesKey = ''; it.linesEdited = false; saveSession(); };
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
  saveSession();
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
  renderComments();
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
    it.linesKey = ''; it.linesEdited = false;
    it.status = '✅ 検出済み';
    saveSession();
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
    // フィニッシュ到達はインパクト後1.5秒程度。それ以降の動き(クラブを
    // 下ろす・歩き出す)を含めないよう前方への拡張は1.7秒で打ち切る
    i = peak; miss = 0;
    while (i < n - 1 && miss <= gap && i - peak < fps * 1.7) {
      i += 1;
      miss = sm[i] < thr ? miss + 1 : 0;
    }
    const ei = i - miss;
    // インパクト(peak)から最低2.5秒前を開始点として保証する。威力の強い/
    // バックスイングの遅いスイングでトップから始まるのを防ぐ
    let start = Math.max(0, Math.min(si / fps - 0.8, peak / fps - 2.5));
    // 終了もインパクトの1.4秒後までは必ず含める(フィニッシュの動作分)。
    // 拡張が早く止まるとインパクト直後で切れてしまうため
    let end = Math.min(total, Math.max(ei / fps + 0.25, peak / fps + 1.4));
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
    // スコア最高の山(=インパクト)を本命にする。以前は「上位のうち最も
    // 早い山」だったが、同じスイングのバックスイングの山を拾って
    // ダウンスイング途中で切れることがあったため変更
    primary = scored.reduce((a, b) => a.score >= b.score ? a : b);
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
  // スイングの動き領域は腕・クラブが中心で、頭(上)と足(下)がはみ出す。
  // 頭・足まで確実に入れるため上下の余白を大きく取る(特に頭側を厚く)
  const mx = bw * 0.25;
  const topM = bh * 0.55, botM = bh * 0.40;
  bx = Math.max(0, bx - mx);
  const by0 = Math.max(0, by - topM);
  bw = Math.min(sw - bx, bw + 2 * mx);
  bh = Math.min(sh - by0, bh + topM + botM);
  by = by0;
  const aspect = tw / th;
  // 最大ズームは2倍まで(切れ防止。以前は3倍で拡大しすぎだった)
  let ch = Math.max(bh, bw / aspect, sh / 2.0);
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
    // アドレス姿勢の妥当性チェック: 手首は肩より下にあるはず。
    // バックスイング中などのフレームを拾ってしまった場合は棄却する
    // (線がすべて急角度にズレる主原因)
    const wrY = (pts[15][1] + pts[16][1]) / 2;
    const shY = (pts[11][1] + pts[12][1]) / 2;
    const hipY = (pts[23][1] + pts[24][1]) / 2;
    if (wrY < shY + (hipY - shY) * 0.25) continue;
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
// ballOverride: ユーザーがタップで指定したボール位置(自動検出より優先)
function computeGuideLinesJS(view, pts, ctx, vw, vh, ballOverride) {
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
  // 後方ビュー。ボールがどちら側かは「手首が腰より前(ボール側)に
  // 出ている」ことで判定する。真後ろからの撮影では顔が見えず、
  // 鼻と耳の位置関係では誤判定するため
  const dx = wrMid[0] >= hipMid[0] ? 1 : -1;
  const rHint = Math.max(3, personH * 0.016);
  let ball;
  if (ballOverride) {
    ball = ballOverride;
  } else {
    const shaftEnd = [wrMid[0] + dx * 0.75 * (groundY - wrMid[1]), groundY];
    const searchR = Math.max(80, personH * 0.25);
    ball = detectBallBlob(ctx, shaftEnd, searchR, rHint, vw, vh) || shaftEnd;
  }

  const lines = [];
  // 1. シャフトの線。ボールはクラブヘッドの先にあるため、起点を
  //    ボールから少し手前(クラブヘッド位置)にずらして実際の
  //    シャフトの角度に合わせる。長さも体の少し後ろまでに抑える
  const anchor = [ball[0] - dx * rHint * 3.2, ball[1]];
  const d1 = dist(anchor, wrMid) + 1e-6;
  const u1 = [(wrMid[0] - anchor[0]) / d1, (wrMid[1] - anchor[1]) / d1];
  const shaftLen = d1 * 1.6;
  lines.push([anchor[0], anchor[1],
              anchor[0] + u1[0] * shaftLen, anchor[1] + u1[1] * shaftLen]);
  // 2. ボール〜首の付け根(頭寄り)の線
  const target = [shMid[0] + (earMid[0] - shMid[0]) * 0.6,
                  shMid[1] + (earMid[1] - shMid[1]) * 0.6];
  const d2 = dist(ball, target) + 1e-6;
  const u2 = [(target[0] - ball[0]) / d2, (target[1] - ball[1]) / d2];
  const neckLen = d2 * 1.15;
  lines.push([ball[0], ball[1], ball[0] + u2[0] * neckLen, ball[1] + u2[1] * neckLen]);
  // 3. 頭の後ろ〜お尻の少し下の線。「頭の後ろ」はボールと反対方向。
  // 顔が見えない真後ろ撮影では鼻の位置が当てにならないため、
  // 耳と鼻の関係がボール方向と矛盾する場合は固定オフセットを使う
  let headBack = [earMid[0] + (earMid[0] - nose[0]) * 0.8,
                  earMid[1] + (earMid[1] - nose[1]) * 0.8];
  if ((earMid[0] - nose[0]) * dx >= 0) {
    headBack = [earMid[0] - dx * 0.55 * headH, earMid[1] - 0.15 * headH];
  }
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
    if (!it.linesEdited) it.lines = null; // 手動編集した線は消さない
    return;
  }
  // 手動で線を動かした場合は、その線を保持して自動計算しない
  if (it.linesEdited && it.lines && it.lines.length) return;
  const key = `${it.start.toFixed(2)}|${it.view}|${it.ballManual || ''}`;
  if (it.linesKey === key) return;
  try {
    // 区間前半の「最も静止しているフレーム」=アドレスに最も近い瞬間を
    // 姿勢推定に使う(検出区間が多少ズレていても線の位置が狂いにくい)。
    // 姿勢の妥当性チェックで棄却された場合に備えて候補は多めに渡す
    let times = [it.start + 0.1, it.start + 0.3, it.start + 0.5,
                 it.start + 0.7, it.start + 0.9];
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
      if (calm.length >= 3) {
        times = calm.slice(0, 4).map(x => x[1]);
        times.push(it.start + 0.15); // 区間先頭付近も必ず候補に入れる
      }
    }
    const { pts, ctx, view } = await poseBest(it, times);
    if (!pts) { it.lines = null; it.linesKey = key; it.viewUsed = '人物検出できず'; return; }
    // 正面の動画ではボール位置は使わない(鼻の縦線のまま)。
    // タップ指定が効くのは後方の線のみ
    const used = (it.view === 'front' || it.view === 'back') ? it.view : view;
    it.lines = computeGuideLinesJS(used, pts, ctx, it.vw, it.vh, it.ballManual);
    it.viewUsed = used === 'front' ? '正面' : '後方';
    it.posePts = pts;   // ドラッグ調整の即時再計算用にキャッシュ
    it.poseUsed = used;
    it.linesKey = key;
    saveSession();
  } catch (e) {
    it.lines = null;
    it.linesKey = key;
    it.viewUsed = '解析失敗';
  }
}

// ---------------- 場面コメント ----------------
// シークバーで場面を選び「コメント追加」→ スロー再生でその場面が
// 4秒間の停止映像になり、コメントが人物と重ならない側に表示される
const COMMENT_SEC = 4;
$('addComment').onclick = () => {
  const it = items[cur];
  if (!it) { setStatus('先に動画を読み込んでください', 'err'); return; }
  if (it.start == null || it.end == null) { setStatus('先にスイング区間を設定してください', 'err'); return; }
  stopPreview();
  video.pause();
  const t = video.currentTime;
  if (t < it.start - 0.05 || t > it.end + 0.05) {
    setStatus('シークバーでスイング区間内(' + fmtShort(it.start) + '〜' + fmtShort(it.end) + ')のコメントしたい場面に移動してから押してください', 'err');
    return;
  }
  $('commentText').value = '';
  $('commentDlgTime').textContent = '(' + fmtShort(t) + 'の場面)';
  $('commentDialog').classList.remove('hidden');
  $('commentText').focus();
};
$('commentCancel').onclick = () => $('commentDialog').classList.add('hidden');
$('commentSave').onclick = () => {
  const it = items[cur];
  const text = $('commentText').value.trim();
  $('commentDialog').classList.add('hidden');
  if (!it || !text) return;
  (it.comments = it.comments || []).push({ t: video.currentTime, text });
  it.comments.sort((a, b) => a.t - b.t);
  renderComments();
  saveSession();
  setStatus('✅ コメントを追加しました。完成動画とプレビューのスロー再生で、この場面が' + COMMENT_SEC + '秒止まって表示されます', 'ok');
};
function renderComments() {
  const box = $('commentList');
  box.innerHTML = '';
  const it = items[cur];
  if (!it || !it.comments || !it.comments.length) return;
  it.comments.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'qrow';
    row.style.padding = '6px 12px';
    const icon = document.createElement('span'); icon.textContent = '💬';
    const time = document.createElement('span'); time.className = 'qrange'; time.textContent = fmtShort(c.t);
    const txt = document.createElement('span'); txt.className = 'qname'; txt.textContent = c.text;
    const del = document.createElement('button'); del.className = 'qdel'; del.textContent = '✕'; del.title = 'このコメントを削除';
    del.onclick = (e) => { e.stopPropagation(); it.comments.splice(i, 1); renderComments(); saveSession(); };
    row.onclick = () => { stopPreview(); video.pause(); video.currentTime = c.t; };
    row.append(icon, time, txt, del);
    box.appendChild(row);
  });
}
// コメントの吹き出しを描く。W/H=描画先サイズ、mapPt=元動画座標→描画先座標
// の変換(書き出しのズーム用、プレビューではnull)
function drawCommentBox(ctx2, it, text, W, H, mapPt) {
  // 人物の中心X(姿勢データの肩・腰から)。無ければ中央とみなす
  let px = W / 2;
  if (it.posePts) {
    let sx = 0;
    for (const i of [11, 12, 23, 24]) sx += it.posePts[i][0];
    px = sx / 4;
    if (mapPt) px = mapPt([px, 0])[0];
  }
  const side = px >= W / 2 ? 'left' : 'right'; // 人物がいない側に置く
  const boxW = W * 0.42;
  const x0 = side === 'left' ? W * 0.04 : W - W * 0.04 - boxW;
  const fsC = Math.max(13, Math.round(H * 0.048));
  ctx2.save();
  ctx2.font = 'bold ' + fsC + 'px sans-serif';
  // 幅に収まるよう文字単位で折り返す
  const maxW = boxW - fsC;
  const lines = [];
  for (const para of String(text).split('\n')) {
    let curLine = '';
    for (const ch of para) {
      if (curLine && ctx2.measureText(curLine + ch).width > maxW) { lines.push(curLine); curLine = ch; }
      else curLine += ch;
    }
    lines.push(curLine);
  }
  const lh = fsC * 1.35;
  const boxH = lines.length * lh + fsC * 0.9;
  const y0 = Math.max(H * 0.05, Math.min(H * 0.42 - boxH / 2, H - boxH - H * 0.05));
  ctx2.globalAlpha = 0.62;
  ctx2.fillStyle = '#000';
  ctx2.beginPath();
  const r = fsC * 0.45;
  if (ctx2.roundRect) ctx2.roundRect(x0, y0, boxW, boxH, r);
  else ctx2.rect(x0, y0, boxW, boxH);
  ctx2.fill();
  ctx2.globalAlpha = 1;
  ctx2.fillStyle = '#fff';
  ctx2.textAlign = 'left';
  ctx2.textBaseline = 'middle';
  lines.forEach((L, i) => {
    if (L) ctx2.fillText(L, x0 + fsC * 0.5, y0 + fsC * 0.45 + lh * i + lh / 2);
  });
  ctx2.restore();
}

// ---------------- 線の即時確認 ----------------
// 書き出しやプレビューを待たず、アドレスの画面に線を重ねて確認する
$('showLines').onclick = async () => {
  const it = items[cur];
  if (!it) { setStatus('先に動画を読み込んでください', 'err'); return; }
  if (it.start == null) { setStatus('先にスイング区間を設定してください', 'err'); return; }
  if (!$('guides').checked || it.view === 'none') {
    setStatus('ガイド線がオフになっています(チェックを入れるか、一覧のプルダウンを「線: 自動」にしてください)', 'err');
    return;
  }
  stopPreview();
  video.pause();
  video.currentTime = Math.min(it.start + 0.2, video.duration || it.start);
  setStatus('<span class="spinner"></span>線を計算しています…(初回はAIモデルの読み込みで少し時間がかかります)');
  await ensureLines(it);
  if (!it.lines) {
    setStatus('⚠ 線を計算できませんでした(人物を検出できない動画の可能性があります)', 'err');
    return;
  }
  drawOverlayLines(it);
  setStatus('✅ 線を表示しています(' + (it.viewUsed || '') + ')。ズレている場合は「🎯 ボール位置を指定」でボールをタップしてください', 'ok');
};

// ---------------- ボール位置の手動指定 ----------------
// ガイド線を1本ずつドラッグで動かせる調整モード。
// スマホでは動画プレーヤーへのタップが再生コントロールに吸収されて
// ツールに届かないため、専用のタップ受け取りレイヤーを動画の上にかぶせる。
// 触った位置に一番近い線をつかんで、その線だけを平行移動する。
$('pickBall').onclick = async () => {
  const it = items[cur];
  if (!it) { setStatus('先に動画を読み込んでください', 'err'); return; }
  if (it.start == null) { setStatus('先にスイング区間を設定してください', 'err'); return; }
  stopPreview();
  video.pause();
  video.currentTime = Math.min(it.start + 0.2, video.duration || it.start);
  setStatus('<span class="spinner"></span>線を計算しています…');
  await ensureLines(it);
  if (!it.lines || !it.lines.length) {
    setStatus('⚠ 線を計算できませんでした(人物を検出できない可能性があります)', 'err');
    return;
  }
  showHandles = true;
  drawOverlayLines(it);
  // 指定中は動画の再生ボタン・シークバー等を隠して線をつかみやすくする
  video.removeAttribute('controls');
  $('pickLayer').classList.remove('hidden');
  setStatus('線の真ん中をドラッグ=平行移動、白い丸(両端)をドラッグ=角度を変更。決まったら「✓ 完了」を押してください', 'ok');
};

// 点(px,py)と線分(x1,y1)-(x2,y2)の距離
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
let dragLineIdx = -1;
let dragMode = 'move'; // 'p1'(始点)/'p2'(終点)=角度変更、'move'=平行移動
let dragLastX = 0, dragLastY = 0;
let pickRaf = false;
function pickCoords(e) {
  const it = items[cur];
  const rect = video.getBoundingClientRect();
  const vw = (it && it.vw) || video.videoWidth || rect.width;
  const vh = (it && it.vh) || video.videoHeight || rect.height;
  return [(e.clientX - rect.left) / rect.width * vw,
          (e.clientY - rect.top) / rect.height * vh];
}
$('pickLayer').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'pickDone') return;
  e.preventDefault();
  const it = items[cur];
  if (!it || !it.lines || !it.lines.length) return;
  const [sx, sy] = pickCoords(e);
  // 触った位置に最も近い線を選ぶ
  let best = -1, bestD = Infinity;
  it.lines.forEach((ln, i) => {
    const d = distToSeg(sx, sy, ln[0], ln[1], ln[2], ln[3]);
    if (d < bestD) { bestD = d; best = i; }
  });
  dragLineIdx = best;
  activeLineIdx = best; // つかんだ線を色替え表示
  // 掴んだのが端(白丸)か真ん中かを判定する。端なら角度変更、中央なら移動
  const L = it.lines[best];
  const grab = Math.min(it.vw, it.vh) * 0.10; // 端をつかむ許容半径
  const d1 = Math.hypot(sx - L[0], sy - L[1]);
  const d2 = Math.hypot(sx - L[2], sy - L[3]);
  if (d1 <= grab && d1 <= d2) dragMode = 'p1';
  else if (d2 <= grab) dragMode = 'p2';
  else dragMode = 'move';
  dragLastX = sx; dragLastY = sy;
  drawOverlayLines(it); // 色替えを即反映
  try { $('pickLayer').setPointerCapture(e.pointerId); } catch (err) {}
});
$('pickLayer').addEventListener('pointermove', (e) => {
  if (dragLineIdx < 0) return;
  e.preventDefault();
  const it = items[cur];
  if (!it || !it.lines) return;
  const [sx, sy] = pickCoords(e);
  const ln = it.lines[dragLineIdx];
  if (dragMode === 'p1') { ln[0] = sx; ln[1] = sy; }          // 始点だけ動かす=角度変更
  else if (dragMode === 'p2') { ln[2] = sx; ln[3] = sy; }     // 終点だけ動かす=角度変更
  else {                                                       // 真ん中=平行移動
    const ddx = sx - dragLastX, ddy = sy - dragLastY;
    ln[0] += ddx; ln[1] += ddy; ln[2] += ddx; ln[3] += ddy;
  }
  dragLastX = sx; dragLastY = sy;
  it.linesEdited = true; // 自動再計算で上書きしない
  if (pickRaf) return;
  pickRaf = true;
  requestAnimationFrame(() => { pickRaf = false; drawOverlayLines(it); });
});
function endDrag() { dragLineIdx = -1; }
$('pickLayer').addEventListener('pointerup', endDrag);
$('pickLayer').addEventListener('pointercancel', endDrag);
$('pickDone').addEventListener('click', (e) => {
  e.stopPropagation();
  dragLineIdx = -1;
  activeLineIdx = -1;  // 色替えを解除(すべて赤に戻す)
  showHandles = false; // つまみを消す(書き出しには含めない)
  const it = items[cur];
  if (it) drawOverlayLines(it);
  $('pickLayer').classList.add('hidden');
  video.setAttribute('controls', ''); // 動画のコントロールを元に戻す
  saveSession();
  setStatus('✅ 線を調整しました(プレビューや書き出しにも反映されます)', 'ok');
});

// ---------------- 範囲設定・候補・プレビュー ----------------
$('detect').onclick = async () => {
  const it = items[cur];
  if (!it) return;
  it.cellDiffs = null;
  it.linesKey = ''; it.linesEdited = false;
  await analyzeItem(it);
};
$('nextCand').onclick = () => {
  const it = items[cur];
  if (!it || it.candidates.length < 2) return;
  it.candIndex = (it.candIndex + 1) % it.candidates.length;
  const c = it.candidates[it.candIndex];
  it.start = c.start; it.end = c.end; it.linesKey = ''; it.linesEdited = false;
  refreshTimes(); renderQueue(); saveSession();
  video.currentTime = it.start;
  setStatus(`✅ 候補${it.candIndex + 1}/${it.candidates.length}: ` +
    fmt(it.start) + ' 〜 ' + fmt(it.end), 'ok');
};
$('setStart').onclick = () => {
  const it = items[cur];
  if (!it) return;
  it.start = video.currentTime; it.linesKey = ''; it.linesEdited = false;
  refreshTimes(); renderQueue(); saveSession();
};
$('setEnd').onclick = () => {
  const it = items[cur];
  if (!it) return;
  it.end = video.currentTime;
  refreshTimes(); renderQueue(); saveSession();
};
document.querySelectorAll('[data-adj]').forEach(btn => {
  btn.onclick = () => {
    const it = items[cur];
    if (!it) return;
    const d = parseFloat(btn.dataset.d);
    if (btn.dataset.adj === 'start' && it.start != null) {
      it.start = Math.max(0, it.start + d);
      it.linesKey = ''; it.linesEdited = false;
      video.currentTime = it.start;
    }
    if (btn.dataset.adj === 'end' && it.end != null) {
      it.end = Math.min(video.duration || Infinity, Math.max(0, it.end + d));
      video.currentTime = it.end;
    }
    refreshTimes(); renderQueue(); saveSession();
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
let phaseSwitching = false; // スロー切り替え中のシークによるpauseを無視する
let previewCmts = [];       // スローでこれから止まる場面
let commentHold = 0;        // コメント停止中の識別トークン(0=停止していない)
function advancePreviewPhase() {
  const it = items[cur];
  if (!it) return;
  if (previewPhase === 1) {
    previewPhase = 2;
    phaseSwitching = true;
    previewCmts = (it.comments || [])
      .filter(c => c.t >= it.start && c.t <= it.end)
      .sort((a, b) => a.t - b.t);
    const rate = parseFloat($('speed').value);
    video.currentTime = it.start;
    showBadge($('speed').value + '倍速');
    drawOverlayLines(it);
    // スマホではシークで再生が止まることがあるため明示的に再開する。
    // playbackRateはplay後にもう一度設定(リセットする端末がある)
    const p = video.play();
    (p || Promise.resolve()).then(() => {
      video.playbackRate = rate;
      phaseSwitching = false;
    }).catch(() => { phaseSwitching = false; });
  } else {
    stopPreview();
  }
}
video.addEventListener('timeupdate', () => {
  if (!previewPhase) return;
  // 切り替えの巻き戻しが終わる前に届いたイベントは無視する。
  // スマホでは巻き戻し完了前にcurrentTimeが古いままのイベントが届き、
  // 「スローも終わった」と誤判定してプレビューが打ち切られていた
  if (phaseSwitching || video.seeking || commentHold) return;
  const it = items[cur];
  if (!it) return;
  // スロー再生中にコメントの場面へ来たら4秒止めて表示する
  if (previewPhase === 2 && previewCmts.length && video.currentTime >= previewCmts[0].t) {
    const c = previewCmts.shift();
    const token = commentHold = Date.now();
    video.pause();
    drawOverlayLines(items[cur]);
    drawCommentBox(overlayCanvas.getContext('2d'), it, c.text, overlayCanvas.width, overlayCanvas.height, null);
    setTimeout(() => {
      if (commentHold !== token) return; // その間に停止・再操作されていたら何もしない
      commentHold = 0;
      if (!previewPhase) return;
      clearOverlay();
      drawOverlayLines(items[cur]);
      const p = video.play();
      (p || Promise.resolve()).then(() => {
        video.playbackRate = parseFloat($('speed').value);
      }).catch(() => {});
    }, COMMENT_SEC * 1000);
    return;
  }
  if (video.currentTime >= it.end) advancePreviewPhase();
});
// 終了位置が動画の末尾と同じ場合、再生が末尾で止まると currentTime が
// it.end にわずかに届かず timeupdate では切り替わらないことがある。
// 「再生し終わった」イベントでも確実に次のフェーズへ進める。
// ただし ended はスロー切り替え(巻き戻し)後に遅れて届くことがあるため、
// 再生位置が本当に終了位置付近にある時だけ進める
video.addEventListener('ended', () => {
  if (!previewPhase || phaseSwitching || video.seeking || commentHold) return;
  const it = items[cur];
  if (!it || video.currentTime < it.end - 0.1) return;
  advancePreviewPhase();
});
video.addEventListener('pause', () => {
  // 切り替えの巻き戻し中・コメント停止中に届いたpauseは無視
  if (phaseSwitching || video.seeking || commentHold) return;
  const it = items[cur];
  if (previewPhase && it && video.currentTime < it.end - 0.05) stopPreview();
});
function stopPreview() {
  previewPhase = 0;
  previewCmts = [];
  commentHold = 0;
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
let showHandles = false; // 線編集中に端の「つまみ」を表示するか
let activeLineIdx = -1;  // 今つかんでいる線(色を変えて示す)
function drawOverlayLines(it) {
  overlayCanvas.width = it.vw;
  overlayCanvas.height = it.vh;
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, it.vw, it.vh);
  if (!it.lines) return;
  const lw = Math.max(3, it.vh / 220);
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  it.lines.forEach(([x1, y1, x2, y2], i) => {
    // 編集中につかんでいる線だけ黄色、それ以外は赤で描く
    ctx.strokeStyle = (showHandles && i === activeLineIdx) ? '#ffd400' : '#ff2d2d';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  });
  if (showHandles) {
    // 各線の両端に白丸のつまみ(ここをドラッグすると角度が変わる)
    const r = lw * 3;
    ctx.lineWidth = Math.max(2, lw * 0.6);
    for (const [x1, y1, x2, y2] of it.lines) {
      for (const [hx, hy] of [[x1, y1], [x2, y2]]) {
        ctx.beginPath();
        ctx.arc(hx, hy, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.strokeStyle = '#ff2d2d';
        ctx.stroke();
      }
    }
  }
}

// ---------------- 書き出し(MediaRecorder) ----------------
// 変換後の動画が本当に再生できるかを確認する。
// メタデータだけでなく「再生可能な状態(canplay)」まで到達し、
// かつ実際に1フレーム進めるかまで検証する(スマホでの再生保証)
function canPlay(blob) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      try { v.pause(); } catch (e) {}
      URL.revokeObjectURL(url);
      res(ok);
    };
    // 長さが読めて、再生可能状態まで来たらOK
    v.oncanplay = () => {
      if (isFinite(v.duration) && v.duration > 0.5) finish(true);
    };
    v.onerror = () => finish(false);
    v.onstalled = () => {};
    setTimeout(() => finish(v.readyState >= 3 && isFinite(v.duration) && v.duration > 0.5), 8000);
    v.src = url;
    v.load();
  });
}

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
  let keepaliveTimer = null;
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
    let onFirstData = null; // 最初の録画データが出たら呼ぶ(エンコード開始の確実な合図)
    recorder.ondataavailable = e => {
      if (!e.data.size) return;
      chunks.push(e.data);
      if (onFirstData) { onFirstData(); onFirstData = null; }
    };
    const stopped = new Promise(res => { recorder.onstop = res; });
    // 録画開始は最初のフレーム描画時まで遅らせる(冒頭の黒画面を防ぐ)

    // 動画の読み込み・シーク中は画面が描き変わらず、その間のコマが動画に
    // 入らない。コマの無い区間があると編集アプリ(KineMaster等)で
    // ストップフレームが押せない・黒く表示されるため、録画中は常に
    // 一定間隔でコマを送り続ける(直前の画面がそのまま静止表示される)
    const vTrack = stream.getVideoTracks()[0];
    keepaliveTimer = setInterval(() => {
      try {
        if (recorder.state !== 'recording') return;
        if (vTrack.requestFrame) vTrack.requestFrame();
        else ctx.drawImage(cvs, 0, 0); // requestFrame非対応ブラウザ向け
      } catch (e) { /* 停止直後のrace等は無視 */ }
    }, 100);

    const introSec = introEnabled() ? INTRO_SEC : 0;
    const totalSec = introSec +
      items.reduce((s, it) => s + (it.end - it.start) * (1 + 1 / speed) +
        (it.comments || []).filter(c => c.t >= it.start && c.t <= it.end).length * COMMENT_SEC, 0);
    let doneSec = 0;

    // 書き出し用のvideoは1つを使い回す。スマホは同時に使える動画
    // プレーヤー数に上限があり、毎回作ると「動画を読み込めませんでした」
    // エラーが出ることがある
    if (!exportVideo) {
      exportVideo = document.createElement('video');
      exportVideo.playsInline = true; exportVideo.preload = 'auto';
      exportSrcNode = ac.createMediaElementSource(exportVideo);
    }
    exportSrcNode.disconnect();
    exportSrcNode.connect(recDest); // スピーカーには出さず録音のみ

    if (introSec) {
      // タイトル画面: 画像を黒背景に収まるよう配置し、テキストを中央に重ねる
      setStatus('<span class="spinner"></span>タイトル画面を書き出し中…');
      let img = null;
      if (introImage) {
        img = await new Promise(res => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => res(null); // 読めない画像は黒背景+文字のみで続行
          im.src = URL.createObjectURL(introImage);
        });
      }
      // 改行で複数行に分ける(空行はそのまま行間として残す)
      const lines = $('introText').value.replace(/\s+$/, '').split('\n');
      const hasText = lines.some(l => l.trim());
      const color = $('introColor').value || '#ffffff';
      const anim = $('introAnim').value || 'none';
      const outline = $('introOutline').checked;
      const outlineColor = $('introOutlineColor').value || '#000000';
      // 文字サイズ: 一番長い行が幅に収まり、全行が高さの75%に収まるまで縮める
      let fs = Math.round(th * 0.10);
      if (hasText) {
        const fits = () => {
          ctx.font = 'bold ' + fs + 'px sans-serif';
          return lines.every(L => ctx.measureText(L).width <= tw * 0.92) &&
            lines.length * fs * 1.3 <= th * 0.75;
        };
        while (fs > 12 && !fits()) fs -= 2;
      }
      const totalChars = lines.join('').length;
      // 録画エンコーダの起動には時間がかかり、開始直後の映像は動画に
      // 入らないことがある(アニメーションが丸ごと欠ける原因)。
      // 「最初の録画データが実際に出てきた」のを確認し、さらに200msの
      // 静止フレームを挟んでからアニメーションの時計を始める
      let t0 = Infinity;
      const startClock = () => { if (t0 === Infinity) t0 = performance.now() + 200; };
      await new Promise(resolve => {
        const draw = () => {
          if (recorder.state === 'inactive') {
            onFirstData = startClock;
            recorder.start(300); // 300msごとにデータを受け取る
            setTimeout(startClock, 2500); // データが来ない環境向けの保険
          }
          const el = Math.max(0, (performance.now() - t0) / 1000);
          const e = 1 - Math.pow(1 - Math.min(1, el / 0.8), 3); // 0.8秒かけてスッと現れる
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, tw, th);
          ctx.save();
          if (anim === 'fade') ctx.globalAlpha = e;
          else if (anim === 'zoom') {
            ctx.globalAlpha = e;
            const k = 0.75 + 0.25 * e;
            ctx.translate(tw / 2, th / 2); ctx.scale(k, k); ctx.translate(-tw / 2, -th / 2);
          } else if (anim === 'slide') {
            ctx.globalAlpha = e;
            ctx.translate(0, th * 0.22 * (1 - e));
          }
          if (img) {
            const s2 = Math.min(tw / img.naturalWidth, th / img.naturalHeight);
            const w = img.naturalWidth * s2, h = img.naturalHeight * s2;
            ctx.drawImage(img, (tw - w) / 2, (th - h) / 2, w, h);
          }
          if (hasText) {
            ctx.font = 'bold ' + fs + 'px sans-serif';
            const lh = fs * 1.3;
            const y0 = th / 2 - lh * (lines.length - 1) / 2;
            ctx.textBaseline = 'middle';
            ctx.fillStyle = color;
            // 「1文字ずつ表示」は1.4秒かけて左から順に出す(位置は固定)
            let budget = anim === 'type'
              ? Math.ceil(totalChars * Math.min(1, el / 1.4)) : Infinity;
            ctx.textAlign = 'left';
            if (outline) {
              ctx.strokeStyle = outlineColor;
              ctx.lineWidth = Math.max(2, fs * 0.14);
              ctx.lineJoin = 'round';
            }
            lines.forEach((L, i) => {
              const shown = budget === Infinity ? L : L.slice(0, Math.max(0, budget));
              if (budget !== Infinity) budget -= L.length;
              if (!shown) return;
              const x = tw / 2 - ctx.measureText(L).width / 2, y = y0 + i * lh;
              if (outline) ctx.strokeText(shown, x, y); // 縁取りは文字の下に描く
              ctx.fillText(shown, x, y);
            });
            ctx.textBaseline = 'alphabetic';
          }
          ctx.restore();
          $('pfill').style.width = Math.min(100, Math.min(el, introSec) / totalSec * 100).toFixed(1) + '%';
          if (el >= introSec) { doneSec += introSec; return resolve(); }
          requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
      });
    }

    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const ev = exportVideo;
      // 読み込み失敗時は少し待って再試行(最大3回)
      let loaded = false, lastErr = null;
      for (let tryN = 0; tryN < 3 && !loaded; tryN++) {
        try {
          if (tryN > 0) {
            ev.removeAttribute('src'); ev.load();
            await new Promise(r => setTimeout(r, 900));
          }
          await loadInto(ev, it.url);
          loaded = true;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!loaded) {
        throw new Error('「' + it.file.name + '」を読み込めませんでした。' +
          '端末のメモリ不足の可能性があります。ページを再読み込みして、動画の本数を減らしてお試しください');
      }
      try { ev.preservesPitch = true; } catch (e) {}
      const rect = useZoom ? zoomRect(it, it.start, it.end, tw, th) : null;
      const cw = rect ? rect.cw : it.vw, chh = rect ? rect.ch : it.vh;
      const cx = rect ? rect.cx : 0, cy = rect ? rect.cy : 0;
      const s = Math.min(tw / cw, th / chh);
      const ox = (tw - cw * s) / 2, oy = (th - chh * s) / 2;
      const mapLine = ([x1, y1, x2, y2]) =>
        [(x1 - cx) * s + ox, (y1 - cy) * s + oy, (x2 - cx) * s + ox, (y2 - cy) * s + oy];

      const playPass = (rate, lines, label, freezes) => new Promise((resolve, reject) => {
        const segDur = it.end - it.start;
        const pend = freezes ? freezes.slice() : []; // これから止まる場面(昇順)
        let freezeCmt = null, freezeUntil = 0;
        const mapPt = ([x, y]) => [(x - cx) * s + ox, (y - cy) * s + oy];
        const drawFrame = () => {
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
        };
        seekTo(ev, it.start).then(() => {
          ev.playbackRate = rate;
          let started = false;
          const draw = () => {
            if (freezeCmt) {
              // コメント付きの停止映像(映像は止めたまま同じ画面を描き続ける)
              drawFrame();
              drawCommentBox(ctx, it, freezeCmt.text, tw, th, mapPt);
              setStatus(`<span class="spinner"></span>書き出し中 (${idx + 1}/${items.length}本目・コメント表示)… 画面を閉じないでください`);
              if (performance.now() >= freezeUntil) {
                freezeCmt = null;
                doneSec += COMMENT_SEC;
                ev.play().then(() => requestAnimationFrame(draw)).catch(reject);
                return;
              }
              requestAnimationFrame(draw);
              return;
            }
            if (ev.currentTime >= it.end || ev.ended) {
              ev.pause();
              // 注意: ここで録画を一時停止してはいけない。iPhoneのSafariは
              // 一時停止すると動画の長さ情報を最初の区間分しか書き込まず、
              // 編集アプリで3秒しか読めないファイルになる。連続録画のまま
              // 次のパスへ移る(切り替えの一瞬は直前の画面が静止表示される)
              doneSec += segDur / rate;
              return resolve();
            }
            if (!started) {
              started = true;
              if (recorder.state === 'inactive') recorder.start(300);
            }
            drawFrame();
            if (pend.length && ev.currentTime >= pend[0].t) {
              freezeCmt = pend.shift();
              freezeUntil = performance.now() + COMMENT_SEC * 1000;
              ev.pause();
              requestAnimationFrame(draw);
              return;
            }
            const prog = (doneSec + Math.max(0, ev.currentTime - it.start) / rate) / totalSec;
            $('pfill').style.width = Math.min(100, prog * 100).toFixed(1) + '%';
            setStatus(`<span class="spinner"></span>書き出し中 (${idx + 1}/${items.length}本目・${label})… 画面を閉じないでください`);
            requestAnimationFrame(draw);
          };
          ev.play().then(() => requestAnimationFrame(draw)).catch(reject);
        });
      });

      const cmts = (it.comments || [])
        .filter(c => c.t >= it.start && c.t <= it.end)
        .sort((a, b) => a.t - b.t);
      await playPass(1, null, '通常速度');
      await playPass(speed, it.lines, 'スロー', cmts);
    }
    exportSrcNode.disconnect();
    exportVideo.removeAttribute('src');
    exportVideo.load();
    clearInterval(keepaliveTimer);
    recorder.stop();
    await stopped;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    let blob = new Blob(chunks, { type: mime.split(';')[0] });
    // MediaRecorderのMP4はフラグメント形式で長さ情報が壊れており、
    // 編集アプリ(Filmora等)で3秒しか読めない。標準の平坦MP4に組み直す
    if (ext === 'mp4' && window.remuxToFlatMP4) {
      setStatus('<span class="spinner"></span>編集アプリで使える形式に変換しています…(最後の仕上げ)');
      try {
        const fixed = await remuxToFlatMP4(blob);
        // 変換後が確実に再生できるか検証してから採用する。
        // 万一再生できない結果になった場合は元のファイル(再生可能)を使う
        if (fixed && fixed.size > 0 && await canPlay(fixed)) blob = fixed;
      } catch (e) { /* 変換失敗時は元のまま保存(再生は可能) */ }
    }
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
    clearInterval(keepaliveTimer);
    $('export').disabled = false;
    $('pbar').classList.add('hidden');
    try { wakeLock?.release(); } catch (e) {}
  }
};

// 左下の再生/一時停止ボタン(中央の再生マークを消したので端に用意)
$('cornerPlay').addEventListener('click', (e) => {
  e.stopPropagation();
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener('play', () => { $('cornerPlay').textContent = '⏸'; });
video.addEventListener('pause', () => { $('cornerPlay').textContent = '▶'; });

// 起動時チェック
if (location.protocol === 'file:') {
  setStatus('⚠ このページはWebサーバー経由で開く必要があります(GitHub Pages等)', 'err');
}
restoreSession();
restoreIntro();

// 開発検証用フック
window.DEBUG_FN = { loadInto, seekTo, seekFrame, waitMeta };
