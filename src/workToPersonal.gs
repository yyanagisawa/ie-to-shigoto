// ===== いえとしごと: 同期2(仕事→個人。説明責任の同期) =====
// 仕事のみの予定を、個人カレンダーへ free(予定なし)の予定としてコピーする。
// free でコピーするため同期1に拾われず、ループしない。

// コピーの識別キー。変更すると既存コピーが孤児化するので変えない
const W2P_TAG_KEY = 'workCopySync';   // extendedProperties識別キー
const W2P_SRC_KEY = 'srcEventId';     // 元イベントID記録用

function syncWorkToPersonal() {
  const cfg = getConfig_();
  const now = new Date();
  const end = new Date(now.getTime() + cfg.SYNC_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const wanted = fetchWorkOnlyEvents_(cfg, now, end);
  const existing = fetchExistingCopies_(cfg, now, end);
  applyCopies_(cfg, wanted, existing);

  Logger.log(`仕事→個人 同期完了: 対象${wanted.size}件`);
}

// 仕事側: 個人が招待されていない予定を抽出。srcId -> {title, s, t, allDay}
// 仕事先が複数あるときは全仕事先の和集合(同じ予定が複数の仕事先にあれば、先に書いた仕事先のものを使う)
function fetchWorkOnlyEvents_(cfg, now, end) {
  const personalEmail = Session.getEffectiveUser().getEmail().toLowerCase();
  const wanted = new Map();
  cfg.WORKS.forEach(work => {
    forEachEvent_(work.email, now, end, {}, ev => {
      if (wanted.has(ev.id)) return;
      if (workSkipReason_(ev, personalEmail, cfg.BLOCK_TITLE)) return;
      const allDay = !ev.start.dateTime;
      wanted.set(ev.id, {
        title: buildCopyTitle(ev, cfg.ONLINE_LOCATION_PATTERNS, work.label),
        s: allDay ? ev.start.date : ev.start.dateTime, // 終日はそのままdateで作る
        t: allDay ? ev.end.date : ev.end.dateTime,
        allDay: allDay,
      });
    });
  });
  return wanted;
}

// 同期2の対象外ならその理由を、対象なら '' を返す
function workSkipReason_(ev, personalEmail, blockTitle) {
  if (ev.status === 'cancelled') return 'キャンセル済み';
  if (ev.transparency === 'transparent') return 'free(予定なし)';
  const me = (ev.attendees || []).find(a => a.self);
  if (me && me.responseStatus === 'declined') return '辞退済み';
  // 個人アドレスも招待されている予定は個人カレンダーに原本がある
  const emails = (ev.attendees || []).map(a => (a.email || '').toLowerCase());
  if (emails.includes(personalEmail)) return '個人アドレスが参加者';
  if (ev.summary === blockTitle) return '同期1が作ったブロック';
  return '';
}

// 個人側: 既存のコピーを取得(extendedPropertiesで検索)。srcId -> 個人側イベント
function fetchExistingCopies_(cfg, now, end) {
  const existing = new Map();
  const params = { privateExtendedProperty: W2P_TAG_KEY + '=true' };
  forEachEvent_(PERSONAL_CALENDAR_ID_, now, end, params, ev => {
    if (ev.status === 'cancelled') return;
    const srcId = ev.extendedProperties?.private?.[W2P_SRC_KEY];
    if (srcId) existing.set(srcId, ev);
  });
  return existing;
}

// 個人カレンダーのコピーを wanted と一致させる(差分のみ削除・更新・作成)
function applyCopies_(cfg, wanted, existing) {
  const throttle = createThrottle_(cfg);

  // 削除: 仕事側から消えたコピーを削除
  existing.forEach((ev, srcId) => {
    if (!wanted.has(srcId)) {
      Calendar.Events.remove(PERSONAL_CALENDAR_ID_, ev.id);
      throttle();
    }
  });

  // 作成・更新
  wanted.forEach((w, srcId) => {
    const timeObj = w.allDay
      ? { start: { date: w.s }, end: { date: w.t } }
      : { start: { dateTime: w.s }, end: { dateTime: w.t } };

    const ex = existing.get(srcId);
    if (ex) {
      // 変更があるときだけ更新
      if (ex.summary === w.title && sameTime_(ex.start, w.s, w.allDay) && sameTime_(ex.end, w.t, w.allDay)) return;
      // 終日⇔時間指定が切り替わったときは、古い側のフィールドを null で明示的に消す
      // (patch はマージ動作のため、消さないと date と dateTime が両方残ってエラーになる)
      if (w.allDay !== !ex.start.dateTime) {
        const stale = w.allDay ? { dateTime: null, timeZone: null } : { date: null };
        Object.assign(timeObj.start, stale);
        Object.assign(timeObj.end, stale);
      }
      Calendar.Events.patch(
        { summary: w.title, ...timeObj },
        PERSONAL_CALENDAR_ID_, ex.id
      );
    } else {
      // 参加者はコピーしない(招待メール事故防止)
      Calendar.Events.insert({
        summary: w.title,
        ...timeObj,
        transparency: 'transparent', // free。個人→仕事同期に拾われない要
        reminders: { useDefault: false, overrides: [] },
        extendedProperties: {
          private: { [W2P_TAG_KEY]: 'true', [W2P_SRC_KEY]: srcId },
        },
      }, PERSONAL_CALENDAR_ID_);
    }
    throttle();
  });
}

// 既存コピーの開始/終了(exPart)が value と同じ時刻か。
// 時間指定は文字列ではなく時刻の値で比べる(カレンダー間でタイムゾーン表記が違っても同一と判定するため)
function sameTime_(exPart, value, allDay) {
  if (allDay) return exPart.date === value;
  return !!exPart.dateTime && new Date(exPart.dateTime).getTime() === new Date(value).getTime();
}

// ===== タイトル生成: 「[仕事先ラベル] 元タイトル @場所ラベル」 =====

// 仕事先のラベル(例: '[F]')があれば先頭に付ける
function buildCopyTitle(ev, onlinePatterns, workLabel) {
  const base = (workLabel ? workLabel + ' ' : '') + (ev.summary || '(無題)');
  const label = extractPlaceLabel(ev, onlinePatterns);
  return label ? `${base} @${label}` : base;
}

function extractPlaceLabel(ev, onlinePatterns) {
  const loc = (ev.location || '').trim();

  // 1. locationに物理的な場所(住所・会議室名)があれば最優先
  if (loc && !isPureUrl(loc)) {
    // location内にURLが混在していたら除去(例: "東京都目黒区... https://meet.google.com/...")
    const physical = loc.replace(/https?:\/\/\S+/gi, '').trim();
    if (physical) return buildPhysicalLabel(physical);
  }

  // 2. 物理的な場所がなければオンライン判定
  if (ev.hangoutLink) return 'Google Meet';
  const online = onlinePatterns.find(p => p.pattern.test(loc));
  if (online) return online.label;
  if (isPureUrl(loc)) return 'オンライン';

  return '';
}

function isPureUrl(s) {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

// 物理的なlocation文字列 → 「中目黒」「中目黒-7F-会議室B」のようなラベル
function buildPhysicalLabel(physical) {
  // 会議室・フロア情報を抽出(例: "7F 会議室B", "3階 大会議室", "Room A")
  const roomParts = [];
  const floorM = physical.match(/(\d+\s*[FＦ階])/);
  if (floorM) roomParts.push(floorM[1].replace(/\s+/g, ''));
  const roomM = physical.match(/((?:大|小|第\d)?会議室[\S]*|Room\s*\S+|ミーティングルーム\S*)/i);
  if (roomM) roomParts.push(roomM[1].replace(/\s+/g, ''));

  // 地名を抽出(例: "東京都目黒区中目黒1-2-3" → "中目黒")
  let place = '';
  // 市区町村名は1文字以上([^都道府県]+?)。「市川市」「町田市」の先頭の市・町を区切りと誤認しないため
  const addrM = physical.replace(/[〒0-9\-‐−ー]+$/, '')
    .match(/(?:都|道|府|県)?[^都道府県]+?(?:市|区|郡|町|村)([^\d\s,、0-9０-９]+)/);
  if (addrM && addrM[1]) {
    // 「丁目」「番地」「番」「号」以降を落とす(「中目黒」の目、「築地」の地などには反応しない)。
    // 直前の漢数字も一緒に落とす(「銀座四丁目」→「銀座」)
    place = addrM[1].replace(/[一二三四五六七八九十]*(?:丁目|番地|番|号).*$/, '');
  } else {
    // 住所形式でなければ先頭ワード(ビル名・オフィス名・会議室名単体など)
    const head = physical.split(/[\s,、]/)[0].slice(0, 15);
    // 先頭ワード自体が会議室情報と同じなら地名なし扱い
    place = roomParts.some(r => head.includes(r) || r.includes(head)) ? '' : head;
  }

  const parts = [place, ...roomParts].filter(Boolean);
  return parts.join('-');
}
