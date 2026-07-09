// MediaRecorderが出力するフラグメントMP4(長さ情報が壊れ、編集アプリで
// 3秒などになる)を、標準的な平坦MP4(moov+単一mdat、faststart)に組み直す。
// mp4box.js で全サンプルを取り出し、moov/stblを自前で構築する。
// 変換に失敗した場合は呼び出し側で元のblobにフォールバックする。
(function () {
  const MOVIE_TS = 1000;

  const b8 = n => new Uint8Array([n & 0xff]);
  const b16 = n => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n); return a; };
  const b32 = n => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0); return a; };
  const str4 = s => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function box(type, ...children) {
    const parts = children.map(c => c instanceof Uint8Array ? c : concat(c));
    let size = 8;
    for (const p of parts) size += p.length;
    return concat([b32(size), str4(type), ...parts]);
  }
  function fullbox(type, version, flags, ...children) {
    return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...children);
  }
  const MATRIX = concat([b32(0x00010000), b32(0), b32(0), b32(0), b32(0x00010000), b32(0), b32(0), b32(0), b32(0x40000000)]);

  function stts(samples) {
    const entries = [];
    for (const s of samples) {
      const d = s.duration;
      if (entries.length && entries[entries.length - 1].d === d) entries[entries.length - 1].c++;
      else entries.push({ c: 1, d });
    }
    const parts = [b32(entries.length)];
    for (const e of entries) { parts.push(b32(e.c)); parts.push(b32(e.d)); }
    return fullbox('stts', 0, 0, ...parts);
  }
  function ctts(samples) {
    let any = false;
    for (const s of samples) if ((s.cts - s.dts) !== 0) { any = true; break; }
    if (!any) return null;
    const entries = [];
    for (const s of samples) {
      const off = s.cts - s.dts;
      if (entries.length && entries[entries.length - 1].o === off) entries[entries.length - 1].c++;
      else entries.push({ c: 1, o: off });
    }
    const parts = [b32(entries.length)];
    for (const e of entries) { parts.push(b32(e.c)); parts.push(b32(e.o)); } // version1相当(符号付き)
    return fullbox('ctts', 1, 0, ...parts);
  }
  function stsz(samples) {
    const parts = [b32(0), b32(samples.length)];
    for (const s of samples) parts.push(b32(s.size));
    return fullbox('stsz', 0, 0, ...parts);
  }
  // 全サンプルを1チャンクにまとめるので、そのチャンクのサンプル数を書く
  function stsc(sampleCount) { return fullbox('stsc', 0, 0, b32(1), b32(1), b32(sampleCount), b32(1)); }
  function stco(offset) { return fullbox('stco', 0, 0, b32(1), b32(offset)); }
  function stss(samples) {
    const nums = [];
    samples.forEach((s, i) => { if (s.is_sync) nums.push(i + 1); });
    if (!nums.length || nums.length === samples.length) return null; // 全部同期なら省略
    const parts = [b32(nums.length)];
    for (const n of nums) parts.push(b32(n));
    return fullbox('stss', 0, 0, ...parts);
  }
  function dinf2() { return box('dinf', fullbox('dref', 0, 0, b32(1), fullbox('url ', 0, 1))); }

  function trak(tr) {
    const isVideo = tr.type === 'video';
    const dur = tr.samples.reduce((a, s) => a + s.duration, 0); // トラック時間軸
    const movieDur = Math.round(dur * MOVIE_TS / tr.timescale);
    const tkhd = fullbox('tkhd', 0, 7,
      b32(0), b32(0), b32(tr.id), b32(0), b32(movieDur),
      b32(0), b32(0), b16(0), b16(0),
      b16(isVideo ? 0 : 0x0100), b16(0), MATRIX,
      b32((tr.width || 0) << 16), b32((tr.height || 0) << 16));
    const mdhd = fullbox('mdhd', 0, 0, b32(0), b32(0), b32(tr.timescale), b32(dur), b16(0x55c4), b16(0));
    const hdlr = fullbox('hdlr', 0, 0, b32(0), str4(isVideo ? 'vide' : 'soun'),
      b32(0), b32(0), b32(0), new Uint8Array([0]));
    const media = isVideo ? fullbox('vmhd', 0, 1, b16(0), b16(0), b16(0), b16(0))
      : fullbox('smhd', 0, 0, b16(0), b16(0));
    const tables = [tr.stsd, stts(tr.samples)];
    const c = ctts(tr.samples); if (c) tables.push(c);
    const ss = isVideo ? stss(tr.samples) : null; if (ss) tables.push(ss);
    tables.push(stsc(tr.samples.length), stsz(tr.samples), stco(tr.chunkOffset));
    const stbl = box('stbl', ...tables);
    const minf = box('minf', media, dinf2(), stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return { box: box('trak', tkhd, mdia), movieDur };
  }

  window.remuxToFlatMP4 = function (blob) {
    return blob.arrayBuffer().then(ab => new Promise((resolve, reject) => {
      const inFile = MP4Box.createFile();
      const tracks = {};
      inFile.onError = e => reject(new Error('parse: ' + e));
      inFile.onReady = (info) => {
        info.tracks.forEach(t => {
          const trak0 = inFile.getTrackById(t.id);
          const entry = trak0.mdia.minf.stbl.stsd.entries[0];
          const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
          entry.write(s);
          const stsdInner = new Uint8Array(s.buffer); // エントリ全体(ヘッダ込み)
          const stsd = fullbox('stsd', 0, 0, b32(1), stsdInner);
          tracks[t.id] = {
            id: t.id, timescale: t.timescale,
            type: t.video ? 'video' : (t.audio ? 'audio' : 'other'),
            width: t.video ? t.video.width : 0,
            height: t.video ? t.video.height : 0,
            stsd, samples: []
          };
          // 全サンプルを一括で受け取る(フラグメントMP4はmoovのnb_samplesが
          // 0なので、その数値には頼らずflush完了後にまとめて組み立てる)
          inFile.setExtractionOptions(t.id, null, { nbSamples: 1e9 });
        });
        inFile.onSamples = (id, user, samples) => {
          const tr = tracks[id];
          for (const s of samples) {
            const data = s.data instanceof Uint8Array ? s.data : new Uint8Array(s.data);
            tr.samples.push({
              data, size: data.length, duration: s.duration,
              dts: s.dts, cts: s.cts,
              is_sync: s.is_sync === undefined ? true : s.is_sync
            });
          }
        };
        inFile.start();
      };
      // ファイル全体を渡してflush。この時点で全サンプルがonSamplesで
      // 届いているので、そのあとに組み立てる
      ab.fileStart = 0;
      inFile.appendBuffer(ab);
      inFile.flush();
      try {
        if (!Object.keys(tracks).length) throw new Error('トラックを読めませんでした');
        resolve(assemble(tracks));
      } catch (e) { reject(e); }
    }));
  };

  function buildMoov(trs) {
    let maxMovieDur = 0;
    const trakBoxes = [];
    for (const tr of trs) {
      const r = trak(tr);
      trakBoxes.push(r.box);
      if (r.movieDur > maxMovieDur) maxMovieDur = r.movieDur;
    }
    const mvhd = fullbox('mvhd', 0, 0, b32(0), b32(0), b32(MOVIE_TS), b32(maxMovieDur),
      b32(0x00010000), b16(0x0100), b16(0), b32(0), b32(0), MATRIX,
      b32(0), b32(0), b32(0), b32(0), b32(0), b32(0),
      b32((trs.reduce((m, t) => Math.max(m, t.id), 0)) + 1));
    return box('moov', mvhd, ...trakBoxes);
  }

  function assemble(tracksMap) {
    const trs = Object.values(tracksMap).filter(t => t.samples.length);
    // スマホ由来の動画と同じく映像トラックを先頭にする(再生互換性のため)
    trs.sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
    const ftyp = box('ftyp', str4('isom'), b32(0x200), str4('isom'), str4('iso2'), str4('avc1'), str4('mp41'));
    // スマホでの互換性のためfaststart(moovをmdatより前)にする。
    // stco(チャンクオフセット)はmoovの中にあるので、まず仮オフセットで
    // moovを作ってサイズを測り、正しいオフセットで作り直す(サイズは不変)
    for (const tr of trs) tr.chunkOffset = 0;
    const moovSize = buildMoov(trs).length;
    const mdatDataStart = ftyp.length + moovSize + 8; // ftyp + moov + mdatヘッダ
    let running = mdatDataStart;
    const dataChunks = [];
    for (const tr of trs) {
      tr.chunkOffset = running;
      for (const s of tr.samples) { dataChunks.push(s.data); running += s.size; }
    }
    const moov = buildMoov(trs); // 本番オフセットで再構築
    const mdatSize = running - mdatDataStart + 8; // 8ヘッダ + データ
    const mdatHeader = concat([b32(mdatSize), str4('mdat')]);

    return new Blob([ftyp, moov, mdatHeader, ...dataChunks], { type: 'video/mp4' });
  }
})();
