// ===== いえとしごと: 診断用関数 =====
// どちらもカレンダーを読むだけで、何も変更しない。
// エディタで関数を選んで実行し、「実行ログ」で結果を見る。

// 両カレンダーの予定を1件ずつ、同期対象かどうかの判定つきで表示する。
// 「なぜこの予定がブロックされない/コピーされないのか」を調べるときに使う。
function debugInspectEvents() {
  const cfg = getConfig_();
  const now = new Date();
  const end = new Date(now.getTime() + cfg.SYNC_DAYS_AHEAD * 24 * 60 * 60 * 1000);
  const verdict = reason => (reason ? '対象外: ' + reason : '対象');
  const line = (ev, text) => `${ev.start.dateTime || ev.start.date} | ${ev.summary || '(無題)'} | ${text}`;

  Logger.log('--- 個人カレンダー(同期1: 対象のものが「' + cfg.BLOCK_TITLE + '」ブロックになる) ---');
  forEachEvent_(PERSONAL_CALENDAR_ID_, now, end, {}, ev => {
    // 仕事先が複数あるときは、仕事先ごとの判定を並べる
    const text = cfg.WORKS
      .map(w => (cfg.WORKS.length > 1 ? w.email + ' → ' : '') + verdict(personalSkipReason_(ev, w.email)))
      .join(' / ');
    Logger.log(line(ev, text));
  });

  const personalEmail = Session.getEffectiveUser().getEmail().toLowerCase();
  cfg.WORKS.forEach(work => {
    Logger.log('--- 仕事カレンダー ' + work.email + '(同期2: 対象のものが個人側へコピーされる) ---');
    forEachEvent_(work.email, now, end, {}, ev => {
      const reason = workSkipReason_(ev, personalEmail, cfg.BLOCK_TITLE);
      const title = reason ? '' : ' → ' + buildCopyTitle(ev, cfg.ONLINE_LOCATION_PATTERNS, work.label);
      Logger.log(line(ev, verdict(reason)) + title);
    });
  });
}

// 同期が作った予定を一覧し、孤児(タグが外れて同期の管理下にないブロック)の候補を示す。
// 孤児候補は内容を確認のうえ、カレンダー上で手動削除する。
function debugInspectBlocks() {
  const cfg = getConfig_();
  const now = new Date();
  const end = new Date(now.getTime() + cfg.SYNC_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  cfg.WORKS.forEach(work => {
    Logger.log('--- 仕事カレンダー ' + work.email + ' の「' + cfg.BLOCK_TITLE + '」 ---');
    let blocks = 0, orphans = 0;
    getWorkCalendar_(work.email).getEvents(now, end).forEach(e => {
      const tagged = e.getTag(SYNC_TAG) === 'true';
      if (!tagged && e.getTitle() !== cfg.BLOCK_TITLE) return;
      tagged ? blocks++ : orphans++;
      Logger.log(`${tagged ? '同期ブロック' : '★孤児候補'} | ${e.getStartTime()} 〜 ${e.getEndTime()} | ${e.getTitle()}`);
    });
    Logger.log(`同期ブロック${blocks}件 / 孤児候補${orphans}件`);
  });

  Logger.log('--- 個人カレンダーの仕事予定コピー ---');
  let copies = 0;
  const params = { privateExtendedProperty: W2P_TAG_KEY + '=true' };
  forEachEvent_(PERSONAL_CALENDAR_ID_, now, end, params, ev => {
    if (ev.status === 'cancelled') return;
    copies++;
    const free = ev.transparency === 'transparent' ? '' : ' | ★busyになっている(同期1に拾われる)';
    Logger.log(`${ev.start.dateTime || ev.start.date} | ${ev.summary}${free}`);
  });
  Logger.log(`コピー${copies}件`);
}
