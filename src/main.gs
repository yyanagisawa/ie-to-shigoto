// ===== いえとしごと: 同期1(個人→仕事)+ 共通処理 + トリガー設定 =====
// 個人のGoogleアカウントで動かす。設定はすべて config.gs の CONFIG に書く。このファイルは編集不要(全文コピペOK)。

// 個人カレンダー = 実行アカウントのメインカレンダー
const PERSONAL_CALENDAR_ID_ = 'primary';

// 同期1が作ったブロックの識別タグ。変更すると既存ブロックが孤児化するので変えない
const SYNC_TAG = 'personal-busy-sync';

// CONFIG で省略された項目に使う既定値(各項目の説明は config.example.gs 参照)
const DEFAULT_CONFIG_ = {
  SYNC_DAYS_AHEAD: 60,
  BLOCK_TITLE: '予定あり',
  TRIGGER_MINUTES: 15,
  THROTTLE_EVERY: 10,
  THROTTLE_SLEEP_MS: 2000,
  ONLINE_LOCATION_PATTERNS: [
    { label: 'Google Meet', pattern: /meet\.google\.com/i },
    { label: 'Zoom', pattern: /zoom\.us/i },
    { label: 'Teams', pattern: /teams\.microsoft\.com/i },
  ],
};

// リトライ対象の一過性エラー
const RETRYABLE_ERRORS_ = [
  'Empty response',
  'Backend Error',
  'Rate Limit',
  'The service is currently unavailable',
  'Internal error',
];
// リトライはしないが通知もしないエラー(短時間では回復しないため次回トリガーに任せる)
const SILENT_ONLY_ERRORS_ = [
  'too many calendars',
  'Service invoked too many times',
];

// よくあるエラーと、確認してほしいこと(実際に遭遇したものだけを載せる)
const ERROR_HINTS_ = [
  {
    match: ['Action not allowed', 'Forbidden'],
    hint: '仕事カレンダーの共有権限が「予定の変更」になっているか確認してください(仕事側のカレンダー設定 →「共有する相手」)。',
  },
  {
    match: ['Not Found'],
    hint: '仕事カレンダーが個人アカウントに追加されているか(共有メールの「このカレンダーを追加」)、config.gs の仕事用アドレスに誤りがないか確認してください。',
  },
];

// 同じ内容のエラーを再通知するまでの間隔(時間)
const NOTIFY_INTERVAL_HOURS_ = 6;

// ===== エントリポイント =====

// 失敗通知付きラッパー(トリガーはこちらに向ける)
function syncBusyBlocksSafe() {
  try {
    withRetry(() => syncBusyBlocks());
    withRetry(() => syncWorkToPersonal());
  } catch (err) {
    const msg = String(err);
    // 一過性エラー: 通知せず次回トリガーに任せる
    if (includesAny_(msg, RETRYABLE_ERRORS_) || includesAny_(msg, SILENT_ONLY_ERRORS_)) {
      Logger.log('一過性エラー。次回トリガーで続行: ' + msg);
      return;
    }
    if (shouldNotify_(msg)) {
      MailApp.sendEmail(
        Session.getEffectiveUser().getEmail(), // 実行アカウント=個人のGmail
        '[いえとしごと] 同期エラー',
        buildErrorMailBody_(err)
      );
    }
    throw err;
  }
}

// 初回セットアップ: 一度実行するとトリガーが設定される
// 注意: このプロジェクトの既存トリガーをすべて削除してから作り直す
function setupTrigger() {
  const minutes = getConfig_().TRIGGER_MINUTES;
  if (![1, 5, 10, 15, 30].includes(minutes)) {
    throw new Error('config.gs の TRIGGER_MINUTES は 1 / 5 / 10 / 15 / 30 のいずれかにしてください: ' + minutes);
  }
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncBusyBlocksSafe')
    .timeBased()
    .everyMinutes(minutes)
    .create();
}

// ===== 同期1: 個人→仕事(プライバシー保護の同期) =====

function syncBusyBlocks() {
  const cfg = getConfig_();
  const now = new Date();
  const end = new Date(now.getTime() + cfg.SYNC_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  // 先にすべて読む(どれか1つでも読めなければ、何も書かずに中止するため)
  const personalEvents = listEvents_(PERSONAL_CALENDAR_ID_, now, end, {});
  // 仕事先が複数あるときは、他の仕事先の予定も「予定あり」の材料にする(仕事Bの会議中は仕事Aもブロック)
  const workEvents = new Map(); // email -> events
  if (cfg.WORKS.length > 1) {
    cfg.WORKS.forEach(w => workEvents.set(w.email, listEvents_(w.email, now, end, {})));
  }

  cfg.WORKS.forEach(target => {
    const busy = personalEvents.filter(ev => !personalSkipReason_(ev, target.email));
    workEvents.forEach((events, email) => {
      if (email === target.email) return;
      busy.push(...events.filter(ev => !otherWorkSkipReason_(ev, target.email, cfg.BLOCK_TITLE)));
    });
    const intervals = busy.map(eventToInterval_).filter(([s, t]) => t > now.getTime());
    const merged = mergeIntervals_(intervals);
    applyBlocks_(cfg, target.email, merged, now, end);

    const which = cfg.WORKS.length > 1 ? `(${target.email})` : '';
    Logger.log(`同期完了${which}: busy区間${intervals.length}件 → ブロック${merged.length}件`);
  });
}

// 他の仕事先の予定を target のブロック材料にしないなら、その理由を返す。
// 条件は個人の予定と同じ(target に原本がある予定は除外)+ 同期1が作ったブロックは除外(ブロックがブロックを生む循環を防ぐ)
function otherWorkSkipReason_(ev, targetEmail, blockTitle) {
  if (ev.summary === blockTitle) return '同期1が作ったブロック';
  return personalSkipReason_(ev, targetEmail);
}

// 同期1の対象外ならその理由を、対象なら '' を返す
function personalSkipReason_(ev, workEmail) {
  const work = workEmail.toLowerCase();
  if (ev.status === 'cancelled') return 'キャンセル済み';
  if (ev.transparency === 'transparent') return 'free(予定なし)';
  const me = (ev.attendees || []).find(a => a.self);
  if (me && me.responseStatus === 'declined') return '辞退済み';
  // 仕事用アドレスも参加している予定は仕事カレンダーに原本がある
  const attendeeEmails = (ev.attendees || []).map(a => (a.email || '').toLowerCase());
  if (attendeeEmails.includes(work)) return '仕事用アドレスが参加者';
  if (ev.organizer && (ev.organizer.email || '').toLowerCase() === work) return '仕事用アドレスが主催者';
  return '';
}

function eventToInterval_(ev) {
  if (ev.start.dateTime) {
    return [new Date(ev.start.dateTime).getTime(), new Date(ev.end.dateTime).getTime()];
  }
  // 終日予定(busyのもののみ)。スクリプトTZの0:00〜として解釈。endは排他的
  return [
    new Date(ev.start.date + 'T00:00:00').getTime(),
    new Date(ev.end.date + 'T00:00:00').getTime(),
  ];
}

// 重なり・連続する区間を統合する
function mergeIntervals_(intervals) {
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, t] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], t);
    } else {
      merged.push([s, t]);
    }
  }
  return merged;
}

// 仕事カレンダーのブロックを merged と一致させる(差分のみ削除・作成)
function applyBlocks_(cfg, workEmail, merged, now, end) {
  const target = getWorkCalendar_(workEmail);
  const existingBlocks = target.getEvents(now, end)
    .filter(e => e.getTag(SYNC_TAG) === 'true');

  const keyOf = (s, t) => `${s}|${t}`;
  const wantedKeys = new Set(merged.map(([s, t]) => keyOf(s, t)));
  const existingKeys = new Set();
  const throttle = createThrottle_(cfg);

  // 不要・重複ブロックを削除
  existingBlocks.forEach(e => {
    const k = keyOf(e.getStartTime().getTime(), e.getEndTime().getTime());
    if (!wantedKeys.has(k) || existingKeys.has(k)) {
      e.deleteEvent();
      throttle();
    } else {
      existingKeys.add(k);
    }
  });

  // 新規ブロックを作成
  merged.forEach(([s, t]) => {
    if (existingKeys.has(keyOf(s, t))) return;
    const ev = target.createEvent(cfg.BLOCK_TITLE, new Date(s), new Date(t));
    ev.setTag(SYNC_TAG, 'true');
    ev.setVisibility(CalendarApp.Visibility.PUBLIC);
    ev.removeAllReminders();
    throttle();
  });
}

// ===== 共通処理 =====

// CONFIG に既定値を補って返す。必須項目が未設定ならエラーで止める
function getConfig_() {
  if (typeof CONFIG === 'undefined') {
    throw new Error('config.gs がありません。config.example.gs をコピーして config.gs を作ってください');
  }
  // 仕事先は WORK_EMAIL(1つ)か WORKS(複数。ラベル付き)のどちらかで指定する
  const works = (CONFIG.WORKS || [{ email: CONFIG.WORK_EMAIL }]).map(w => ({ email: w.email, label: w.label || '' }));
  if (!works.length || works.some(w => !w.email || /example\.com$/i.test(w.email))) {
    throw new Error('config.gs の WORK_EMAIL が未設定です(サンプル値のままになっていませんか)');
  }
  // 終日予定を「スクリプトのタイムゾーンの0:00〜」として扱うため、東京以外では日付がずれる
  const tz = Session.getScriptTimeZone();
  if (tz !== 'Asia/Tokyo') {
    throw new Error('プロジェクトのタイムゾーンが東京ではありません(現在: ' + tz + ')。「プロジェクトの設定」でタイムゾーンを「(GMT+09:00) 日本標準時 - 東京」にしてください');
  }
  return Object.assign({}, DEFAULT_CONFIG_, CONFIG, { WORKS: works });
}

// 仕事カレンダー(IDは仕事用アドレス)。個人アカウントに共有・追加されていないと取得できない
function getWorkCalendar_(workEmail) {
  const cal = CalendarApp.getCalendarById(workEmail);
  if (!cal) {
    throw new Error('仕事カレンダーが見つかりません。仕事カレンダーを個人アカウントに「予定の変更」権限で共有し、個人側でカレンダーを追加してください: ' + workEmail);
  }
  return cal;
}

// 期間内の予定をページングしながら1件ずつ fn に渡す
function forEachEvent_(calendarId, now, end, extraParams, fn) {
  let pageToken = null;
  do {
    const res = Calendar.Events.list(calendarId, Object.assign({
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true, // 繰り返し予定を展開
      maxResults: 2500,
    }, extraParams, { pageToken: pageToken }));
    (res.items || []).forEach(fn);
    pageToken = res.nextPageToken;
  } while (pageToken);
}

function listEvents_(calendarId, now, end, extraParams) {
  const events = [];
  forEachEvent_(calendarId, now, end, extraParams, ev => events.push(ev));
  return events;
}

// スロットリング: 書き込み THROTTLE_EVERY 件ごとに THROTTLE_SLEEP_MS 休む
function createThrottle_(cfg) {
  let writeCount = 0;
  return () => {
    writeCount++;
    if (writeCount % cfg.THROTTLE_EVERY === 0) Utilities.sleep(cfg.THROTTLE_SLEEP_MS);
  };
}

// エラー通知メールの本文。何が起きたか・何を確認するか・このあとどうなるかを先に書き、スタックトレースは末尾に置く
function buildErrorMailBody_(err) {
  const msg = String(err);
  const found = ERROR_HINTS_.find(h => includesAny_(msg, h.match));
  const hint = found ? found.hint : 'エラー内容に心当たりがなければ、セットアップ手順書(docs/setup.md)の「うまくいかないとき」を確認してください。';
  return [
    'いえとしごと(個人と仕事の Google カレンダーの自動同期)でエラーが起きました。',
    '',
    '■ エラー内容',
    msg,
    '',
    '■ 確認してほしいこと',
    hint,
    '',
    '■ このあとの動き',
    '・同期は自動で再試行されます。原因が解消すれば、何もしなくても次回の実行から復旧します。',
    '・同じ内容のエラーの通知は ' + NOTIFY_INTERVAL_HOURS_ + ' 時間に1回だけ送られます。',
    '・Google 側の一時的なエラーは通知されません。このメールが届いた場合は、待っても直らない可能性が高いエラーです。',
    '',
    '■ 技術的な詳細',
    String(err && err.stack || err),
  ].join('\n');
}

// 同じ内容のエラー通知は NOTIFY_INTERVAL_HOURS_ に1回だけ(15分ごとのメール連発を防ぐ)
function shouldNotify_(msg) {
  const props = PropertiesService.getScriptProperties();
  const last = JSON.parse(props.getProperty('lastErrorNotice') || '{}');
  const now = Date.now();
  if (last.msg === msg && now - last.at < NOTIFY_INTERVAL_HOURS_ * 60 * 60 * 1000) return false;
  props.setProperty('lastErrorNotice', JSON.stringify({ msg: msg, at: now }));
  return true;
}

function includesAny_(msg, patterns) {
  return patterns.some(p => msg.includes(p));
}

// 一過性エラーは指数バックオフで最大3回リトライ
function withRetry(fn) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!includesAny_(String(err), RETRYABLE_ERRORS_)) throw err;
      Utilities.sleep(3000 * Math.pow(2, i)); // 3秒→6秒→12秒
    }
  }
  throw lastErr;
}
