// ===== いえとしごと: 設定 =====
// このファイルの内容を config.gs という名前で貼り付け、WORK_EMAIL だけ書き換えてください。

const CONFIG = {
  // ★ 書き換えるのはここだけ: 仕事用のメールアドレス
  WORK_EMAIL: 'you@your-company.example.com',

  // ---------------------------------------------------------------
  // ここから下は変更不要です(そのままで動きます)。
  // カスタマイズしたい人だけ、行頭の // を外して値を書き換えてください。
  // ---------------------------------------------------------------
  // WORKS: [                   // 仕事先が複数ある場合(WORK_EMAIL の代わりに指定)。label は個人側のコピーのタイトル先頭に付く
  //   { email: 'you@company-a.example.com', label: '[A]' },
  //   { email: 'you@company-b.example.com', label: '[B]' },
  // ],
  // SYNC_DAYS_AHEAD: 60,       // 何日先まで同期するか
  // BLOCK_TITLE: '予定あり',    // 仕事側に作るブロックのタイトル(運用開始後に変える場合は README の FAQ を参照)
  // TRIGGER_MINUTES: 15,       // 自動実行の間隔(分)。1 / 5 / 10 / 15 / 30 のみ。変更後は setupTrigger を再実行
  // THROTTLE_EVERY: 10,        // レート制限対策: 書き込み何件ごとに休むか
  // THROTTLE_SLEEP_MS: 2000,   // レート制限対策: 休む長さ(ミリ秒)
  // ONLINE_LOCATION_PATTERNS: [  // 場所欄が URL だけの予定に付けるラベル(上から順に判定。g フラグは付けない)
  //   { label: 'Google Meet', pattern: /meet\.google\.com/i },
  //   { label: 'Zoom', pattern: /zoom\.us/i },
  //   { label: 'Teams', pattern: /teams\.microsoft\.com/i },
  //   { label: 'Webex', pattern: /webex\.com/i },  // ← 追加の例
  // ],
};
