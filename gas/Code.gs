/**
 * Obsidian Daily Poster - GAS Backend
 * -----------------------------------
 * 音声/テキストで送られてきたメモを Gemini API で分類し、
 * Google ドライブ上の Obsidian ボルト内「00_Daily/YYYY-MM-DD.md」の
 * 該当する見出し（テンプレート準拠）に振り分けて追記する。
 *
 * 【対応テンプレート】_daily_template.md
 *   # YYYY-MM-DD
 *   ## 今日触るプロジェクト
 *   ## 作業ログ / 意思決定
 *   ## デプロイ確認
 *     - [ ] GASデプロイ版を更新し確認した
 *   ## 明日への積み残し
 *
 * 【事前設定】スクリプトのプロパティ (プロジェクトの設定 > スクリプト プロパティ) に以下を登録してください。
 *   GEMINI_API_KEY      : Gemini APIキー
 *   DAILY_FOLDER_ID      : Obsidian ボルト内「00_Daily」フォルダの Google ドライブ フォルダID
 *   USER_SHEET_ID        : ユーザー管理用スプレッドシートのID（未設定なら初回実行時に自動作成）
 *
 * 【スプレッドシート構成】シート名 "Users"
 *   A列: email  B列: salt  C列: passwordHash  D列: nickname  E列: isTempPassword  F列: createdAt
 */

// ==================== 設定 ====================
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    GEMINI_API_KEY: props.getProperty('GEMINI_API_KEY'),
    DAILY_FOLDER_ID: props.getProperty('DAILY_FOLDER_ID'),
    USER_SHEET_ID: props.getProperty('USER_SHEET_ID')
  };
}

var SESSION_TTL_SEC = 6 * 60 * 60; // 6時間（CacheServiceの上限）

// テンプレートの見出し文字列（_daily_template.md と完全一致させること）
var HEADING_PROJECTS = '## 今日触るプロジェクト';
var HEADING_WORKLOG = '## 作業ログ / 意思決定';
var HEADING_DEPLOY = '## デプロイ確認';
var HEADING_LEFTOVER = '## 明日への積み残し';
var DEPLOY_ITEM_TEXT = 'GASデプロイ版を更新し確認した';

// ==================== エントリーポイント ====================

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'Obsidian Daily Poster API is running.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result;
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action;

    switch (action) {
      case 'register':
        result = handleRegister_(body);
        break;
      case 'login':
        result = handleLogin_(body);
        break;
      case 'forgotPassword':
        result = handleForgotPassword_(body);
        break;
      case 'resetPassword':
        result = handleResetPassword_(body);
        break;
      case 'updateNickname':
        result = handleUpdateNickname_(body);
        break;
      case 'submitNote':
        result = handleSubmitNote_(body);
        break;
      case 'getNoteByDate':
        result = handleGetNoteByDate_(body);
        break;
      default:
        result = { ok: false, error: '不明なアクションです: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: 'サーバーエラー: ' + err.message };
  }
  return jsonOut_(result);
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== ユーザーシート ====================

var COL = { EMAIL: 0, SALT: 1, HASH: 2, NICKNAME: 3, TEMP_FLAG: 4, CREATED_AT: 5 };

function getUserSheet_() {
  var config = getConfig_();
  var ss;
  if (config.USER_SHEET_ID) {
    ss = SpreadsheetApp.openById(config.USER_SHEET_ID);
  } else {
    ss = SpreadsheetApp.create('ObsidianDailyPoster_Users');
    PropertiesService.getScriptProperties().setProperty('USER_SHEET_ID', ss.getId());
  }
  var sheet = ss.getSheetByName('Users');
  if (!sheet) {
    sheet = ss.insertSheet('Users');
    sheet.appendRow(['email', 'salt', 'passwordHash', 'nickname', 'isTempPassword', 'createdAt']);
  }
  return sheet;
}

function findUserRow_(sheet, email) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][COL.EMAIL]).toLowerCase() === String(email).toLowerCase()) {
      return {
        rowIndex: i + 1,
        email: data[i][COL.EMAIL],
        salt: data[i][COL.SALT],
        passwordHash: data[i][COL.HASH],
        nickname: data[i][COL.NICKNAME],
        isTempPassword: data[i][COL.TEMP_FLAG] === true || data[i][COL.TEMP_FLAG] === 'TRUE'
      };
    }
  }
  return null;
}

function hashPassword_(password, salt) {
  var digest = Utilities.computeHmacSha256Signature(password, salt);
  return digest.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function generateTempPassword_() {
  // 読み間違えにくい8文字のランダムパスワード（英大文字・数字）
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  for (var i = 0; i < 8; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

// ==================== 会員登録 / ログイン ====================

function handleRegister_(body) {
  var email = (body.email || '').trim();
  var password = body.password || '';
  var nickname = (body.nickname || '').trim() || email.split('@')[0];
  if (!email || !password) {
    return { ok: false, error: 'メールアドレスとパスワードを入力してください。' };
  }
  if (password.length < 6) {
    return { ok: false, error: 'パスワードは6文字以上にしてください。' };
  }
  var sheet = getUserSheet_();
  if (findUserRow_(sheet, email)) {
    return { ok: false, error: 'このメールアドレスは既に登録されています。' };
  }
  var salt = Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  sheet.appendRow([email, salt, hash, nickname, false, new Date()]);
  return { ok: true, message: '登録が完了しました。ログインしてください。' };
}

function handleLogin_(body) {
  var email = (body.email || '').trim();
  var password = body.password || '';
  var sheet = getUserSheet_();
  var user = findUserRow_(sheet, email);
  if (!user) {
    return { ok: false, error: 'メールアドレスまたはパスワードが違います。' };
  }
  var hash = hashPassword_(password, user.salt);
  if (hash !== user.passwordHash) {
    return { ok: false, error: 'メールアドレスまたはパスワードが違います。' };
  }
  var token = Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put('session_' + token, user.email, SESSION_TTL_SEC);
  return {
    ok: true,
    token: token,
    email: user.email,
    nickname: user.nickname,
    requiresPasswordReset: !!user.isTempPassword
  };
}

function verifySession_(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var email = cache.get('session_' + token);
  if (email) {
    // アクセスがあるたびに有効期限を延長する
    cache.put('session_' + token, email, SESSION_TTL_SEC);
  }
  return email;
}

// ==================== 動作確認用（テスト後は削除可） ====================

/**
 * このテスト関数は実行ドロップダウンに単体で表示されるので、選択して実行すると
 * ①メール送信権限の承認ダイアログが出るか ②実際にメールが届くか を確認できます。
 * 実行後、実行ログ（左メニューの時計アイコン）にも結果が出力されます。
 */
function testSendMail() {
  var myEmail = Session.getActiveUser().getEmail();
  Logger.log('送信先: ' + myEmail);
  try {
    MailApp.sendEmail({
      to: myEmail,
      subject: '【テスト】Obsidian Daily Poster 送信確認',
      body: 'このメールが届いていれば、MailAppからの送信は正常に動作しています。'
    });
    Logger.log('送信処理は正常に完了しました。');
  } catch (err) {
    Logger.log('送信エラー: ' + err.message);
  }
}

/**
 * handleForgotPassword_ を実際のメールアドレスで直接テストしたい場合はこちらを使う。
 * YOUR_TEST_EMAIL を、Usersシートに登録済みのメールアドレスに書き換えて実行してください。
 */
function testForgotPassword() {
  var result = handleForgotPassword_({ email: 'YOUR_TEST_EMAIL@example.com' });
  Logger.log(JSON.stringify(result));
}

/**
 * Gemini分類のテスト用。実行ログに構造化結果が出ます。
 */
function testStructureNote() {
  var sample = 'nokori-monoのレシピ提案の不具合を直した。あと明日は美味しい1杯のお気に入り機能を実装する予定。GASのデプロイはさっき更新して確認済み。';
  var result = structureWithGeminiTemplate_(sample);
  Logger.log(JSON.stringify(result));
}

// ==================== パスワード忘れ / 再登録 ====================

function handleForgotPassword_(body) {
  var email = (body.email || '').trim();
  var sheet = getUserSheet_();
  var user = findUserRow_(sheet, email);
  // メールアドレスの存在有無を外部から判別できないよう、常に同じ成功メッセージを返す
  var genericMsg = { ok: true, message: 'ご登録のメールアドレスに仮パスワードを送信しました（該当する登録がある場合）。' };
  if (!user) {
    return genericMsg;
  }

  var tempPassword = generateTempPassword_();
  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(tempPassword, newSalt);
  sheet.getRange(user.rowIndex, COL.SALT + 1).setValue(newSalt);
  sheet.getRange(user.rowIndex, COL.HASH + 1).setValue(newHash);
  sheet.getRange(user.rowIndex, COL.TEMP_FLAG + 1).setValue(true);

  try {
    MailApp.sendEmail({
      to: user.email,
      subject: '【Obsidian Daily Poster】仮パスワードのお知らせ',
      body:
        user.nickname + ' 様\n\n' +
        'パスワード再発行のリクエストを受け付けました。\n' +
        '以下の仮パスワードでログインし、必ず新しいパスワードを再登録してください。\n\n' +
        '仮パスワード: ' + tempPassword + '\n\n' +
        '※このメールに心当たりがない場合は、無視していただいて問題ありません。'
    });
  } catch (mailErr) {
    return { ok: false, error: 'メール送信に失敗しました: ' + mailErr.message };
  }

  return genericMsg;
}

function handleResetPassword_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var newPassword = body.newPassword || '';
  if (newPassword.length < 6) {
    return { ok: false, error: '新しいパスワードは6文字以上にしてください。' };
  }
  var sheet = getUserSheet_();
  var user = findUserRow_(sheet, email);
  if (!user) {
    return { ok: false, error: 'ユーザーが見つかりません。' };
  }
  var newSalt = Utilities.getUuid();
  var newHash = hashPassword_(newPassword, newSalt);
  sheet.getRange(user.rowIndex, COL.SALT + 1).setValue(newSalt);
  sheet.getRange(user.rowIndex, COL.HASH + 1).setValue(newHash);
  sheet.getRange(user.rowIndex, COL.TEMP_FLAG + 1).setValue(false);
  return { ok: true, message: 'パスワードを再登録しました。' };
}

// ==================== ニックネーム変更 ====================

function handleUpdateNickname_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var nickname = (body.nickname || '').trim();
  if (!nickname) {
    return { ok: false, error: 'ニックネームを入力してください。' };
  }
  var sheet = getUserSheet_();
  var user = findUserRow_(sheet, email);
  if (!user) {
    return { ok: false, error: 'ユーザーが見つかりません。' };
  }
  sheet.getRange(user.rowIndex, COL.NICKNAME + 1).setValue(nickname);
  return { ok: true, nickname: nickname };
}

// ==================== メモ投稿処理（テンプレート振り分け） ====================

function handleSubmitNote_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var rawText = (body.text || '').trim();
  if (!rawText) {
    return { ok: false, error: 'テキストが空です。' };
  }

  var structured = structureWithGeminiTemplate_(rawText);
  var todayFileName = formatDateForFile_(new Date()) + '.md';
  var updatedContent = appendToDailyNoteTemplate_(todayFileName, structured);

  return {
    ok: true,
    fileName: todayFileName,
    appended: buildSummaryText_(structured),
    noteContent: updatedContent
  };
}

function formatDateForFile_(date) {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd');
}

/**
 * 指定日（YYYY-MM-DD）のDailyノートの内容を取得する。
 * 見つからない場合はエラーにせず exists:false を返す。
 */
function handleGetNoteByDate_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var dateStr = (body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, error: '日付の形式が正しくありません（YYYY-MM-DD）。' };
  }
  var config = getConfig_();
  if (!config.DAILY_FOLDER_ID) {
    throw new Error('DAILY_FOLDER_ID が設定されていません。');
  }
  var folder = DriveApp.getFolderById(config.DAILY_FOLDER_ID);
  var fileName = dateStr + '.md';
  var files = folder.getFilesByName(fileName);
  if (!files.hasNext()) {
    return { ok: true, exists: false, fileName: fileName, noteContent: null };
  }
  var file = files.next();
  var content = file.getBlob().getDataAsString('UTF-8');
  return { ok: true, exists: true, fileName: fileName, noteContent: content };
}

/**
 * Geminiに、テンプレートの4区分（プロジェクト／作業ログ・意思決定／デプロイ確認／積み残し）へ
 * 分類させ、JSONで受け取る。
 */
function structureWithGeminiTemplate_(rawText) {
  var config = getConfig_();
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY が設定されていません。');
  }

  var systemPrompt =
    'あなたはObsidianのDailyノート整理アシスタントです。入力された雑多な音声書き起こしやテキストを、' +
    '次のJSON形式「だけ」で出力してください。前後の挨拶・説明・Markdownのコードブロック記号（```）は' +
    '絶対に付けないでください。\n\n' +
    '{\n' +
    '  "projects": ["今日触れた/触る予定のプロジェクト名や作業対象を短い箇条書きで"],\n' +
    '  "workLog": ["作業内容・進捗・意思決定を短い箇条書きで"],\n' +
    '  "deployDone": true または false （GASデプロイ版の更新・確認について言及されていればtrue、それ以外はfalse）,\n' +
    '  "leftover": ["明日以降に持ち越すタスクを短い箇条書きで"]\n' +
    '}\n\n' +
    '該当する内容がない項目は空配列 [] にしてください。分類に迷う内容は "workLog" に入れてください。' +
    '各項目の文章は簡潔な体言止め・常体でまとめてください。';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + config.GEMINI_API_KEY;
  var payload = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n【入力】\n' + rawText }] }
    ]
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Gemini API エラー (' + code + '): ' + res.getContentText());
  }
  var json = JSON.parse(res.getContentText());
  var text = json.candidates &&
    json.candidates[0] &&
    json.candidates[0].content &&
    json.candidates[0].content.parts &&
    json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;

  if (!text) {
    throw new Error('Geminiからの応答を解析できませんでした。');
  }

  // Geminiがコードブロック記号を付けてしまった場合の保険
  text = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseErr) {
    // JSONとして解釈できない場合は、全文を作業ログ扱いにして保存だけは継続する
    parsed = { projects: [], workLog: [rawText], deployDone: false, leftover: [] };
  }

  return {
    projects: Array.isArray(parsed.projects) ? parsed.projects.filter(Boolean) : [],
    workLog: Array.isArray(parsed.workLog) ? parsed.workLog.filter(Boolean) : [],
    deployDone: !!parsed.deployDone,
    leftover: Array.isArray(parsed.leftover) ? parsed.leftover.filter(Boolean) : []
  };
}

/**
 * UI表示用に、分類結果を人が読める形式のテキストへ整形する（ファイルには使わない）。
 */
function buildSummaryText_(structured) {
  var blocks = [];
  if (structured.projects.length) {
    blocks.push('■ 今日触るプロジェクト\n' + structured.projects.map(function (i) { return '- ' + i; }).join('\n'));
  }
  if (structured.workLog.length) {
    blocks.push('■ 作業ログ / 意思決定\n' + structured.workLog.map(function (i) { return '- ' + i; }).join('\n'));
  }
  if (structured.deployDone) {
    blocks.push('■ デプロイ確認\n- [x] ' + DEPLOY_ITEM_TEXT);
  }
  if (structured.leftover.length) {
    blocks.push('■ 明日への積み残し\n' + structured.leftover.map(function (i) { return '- ' + i; }).join('\n'));
  }
  if (!blocks.length) {
    return '（分類できる内容がありませんでした。テキストを見直して再度お試しください）';
  }
  return blocks.join('\n\n');
}

/**
 * 当日のDailyノートを取得（無ければテンプレート雛形で新規作成）し、
 * 各見出しの下に分類済み項目を挿入して保存する。
 * 保存後のファイル全文（string）を返す。
 */
function appendToDailyNoteTemplate_(fileName, structured) {
  var config = getConfig_();
  if (!config.DAILY_FOLDER_ID) {
    throw new Error('DAILY_FOLDER_ID が設定されていません。');
  }
  var folder = DriveApp.getFolderById(config.DAILY_FOLDER_ID);
  var files = folder.getFilesByName(fileName);

  var file = null;
  var content;
  if (files.hasNext()) {
    file = files.next();
    content = file.getBlob().getDataAsString('UTF-8');
  } else {
    content = buildDailyTemplateSkeleton_(fileName.replace('.md', ''));
  }

  content = insertItemsUnderHeading_(content, HEADING_PROJECTS, structured.projects);
  content = insertItemsUnderHeading_(content, HEADING_WORKLOG, structured.workLog);
  content = insertItemsUnderHeading_(content, HEADING_LEFTOVER, structured.leftover);
  if (structured.deployDone) {
    content = markDeployChecked_(content);
  }

  if (file) {
    file.setContent(content);
  } else {
    folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  }

  return content;
}

/**
 * _daily_template.md 相当の雛形テキストを組み立てる
 * （Templaterの <% tp.date.now(...) %> は実行時点では使えないため実日付に置換）。
 */
function buildDailyTemplateSkeleton_(dateLabel) {
  return '# ' + dateLabel + '\n\n' +
    HEADING_PROJECTS + '\n- \n\n' +
    HEADING_WORKLOG + '\n- \n\n' +
    HEADING_DEPLOY + '\n- [ ] ' + DEPLOY_ITEM_TEXT + '\n\n' +
    HEADING_LEFTOVER + '\n- \n';
}

/**
 * content内の指定見出しセクション（次の "## " 見出し、または末尾まで）の末尾に
 * 箇条書き項目を挿入する。見出しが存在しない場合は末尾に新設する。
 */
function insertItemsUnderHeading_(content, heading, items) {
  if (!items || items.length === 0) return content;

  var headingIndex = content.indexOf(heading);
  var newLines = items.map(function (i) { return '- ' + i; }).join('\n') + '\n';

  if (headingIndex === -1) {
    var sep = content.endsWith('\n') ? '\n' : '\n\n';
    return content + sep + heading + '\n' + newLines;
  }

  var searchFrom = headingIndex + heading.length;
  var nextHeadingIndex = content.indexOf('\n## ', searchFrom);
  var insertPos = nextHeadingIndex === -1 ? content.length : nextHeadingIndex + 1; // 見出し行頭の直前

  var before = content.substring(0, insertPos);
  var after = content.substring(insertPos);
  if (!before.endsWith('\n')) before += '\n';

  return before + newLines + after;
}

/**
 * デプロイ確認のチェックボックスを [x] に更新する。
 * 既存行が見つからなければ見出し配下に新設する。
 */
function markDeployChecked_(content) {
  var uncheckedLine = '- [ ] ' + DEPLOY_ITEM_TEXT;
  var checkedLine = '- [x] ' + DEPLOY_ITEM_TEXT;
  if (content.indexOf(checkedLine) !== -1) return content;
  if (content.indexOf(uncheckedLine) !== -1) {
    return content.replace(uncheckedLine, checkedLine);
  }
  return insertItemsUnderHeading_(content, HEADING_DEPLOY, ['[x] ' + DEPLOY_ITEM_TEXT]);
}
