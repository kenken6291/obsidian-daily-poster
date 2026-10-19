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
 *   VAULT_FOLDER_ID      : （任意）ボルト「健二保管庫」ルートのフォルダID。未設定なら 00_Daily の親フォルダを自動採用
 *   GEMINI_MODEL         : （任意）Geminiモデル名。未設定なら gemini-3.6-flash
 *   DEFAULT_NOTE_FOLDER  : （任意）AIが保存先を決められなかった時のフォルダ（ボルト内パス）。未設定なら 10_free_memo
 *
 * 【v2.2 変更】GAS URL を config.js に分離、画面・GASのバージョン表示（不一致警告）。
 * 【v2.1 追加】Gemini整形結果をいったん画面に返し（formatNote）、ユーザーが修正してから保存（saveNote）。
 *   保存後のノートも画面から修正して上書き保存できる（updateSavedNote）。
 * 【v2.0 追加】Geminiで整えたノートを、健二保管庫内の適切なフォルダへ新規ファイルとして保存し、
 *   当日の 00_Daily にはそのノートへのリンク＋分類結果を追記する。
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
    USER_SHEET_ID: props.getProperty('USER_SHEET_ID'),
    VAULT_FOLDER_ID: props.getProperty('VAULT_FOLDER_ID'),
    GEMINI_MODEL: props.getProperty('GEMINI_MODEL') || 'gemini-3.6-flash',
    DEFAULT_NOTE_FOLDER: props.getProperty('DEFAULT_NOTE_FOLDER') || '10_free_memo'
  };
}

var SESSION_TTL_SEC = 6 * 60 * 60; // 6時間（CacheServiceの上限）

// テンプレートの見出し文字列（_daily_template.md と完全一致させること）
var HEADING_PROJECTS = '## 今日触るプロジェクト';
var HEADING_WORKLOG = '## 作業ログ / 意思決定';
var HEADING_DEPLOY = '## デプロイ確認';
var HEADING_LEFTOVER = '## 明日への積み残し';
var DEPLOY_ITEM_TEXT = 'GASデプロイ版を更新し確認した';

// 画面側 index.html の APP_VERSION と揃えて更新する（不一致だと画面下に警告表示）
var APP_VERSION = 'v2.2 (2026-10-19)';
var FOLDER_CACHE_KEY = 'vault_folders_v2';
var FOLDER_CACHE_SEC = 10 * 60;   // フォルダ一覧のキャッシュ 10分
var FOLDER_MAX_DEPTH = 3;         // ボルト内を何階層まで候補にするか
var FOLDER_MAX_COUNT = 300;

// ==================== エントリーポイント ====================

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, message: 'Obsidian Daily Poster API is running.', version: APP_VERSION }))
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
      case 'formatNote':
        result = handleFormatNote_(body);
        break;
      case 'saveNote':
        result = handleSaveNote_(body);
        break;
      case 'updateSavedNote':
        result = handleUpdateSavedNote_(body);
        break;
      case 'listFolders':
        result = handleListFolders_(body);
        break;
      case 'getNoteByDate':
        result = handleGetNoteByDate_(body);
        break;
      case 'updateNoteByDate':
        result = handleUpdateNoteByDate_(body);
        break;
      case 'deleteNoteByDate':
        result = handleDeleteNoteByDate_(body);
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
  var folders = listVaultFolders_(true).map(function (f) { return f.path; });
  Logger.log('フォルダ候補: ' + folders.join(', '));
  var result = structureWithGeminiTemplate_(sample, folders);
  Logger.log(JSON.stringify(result, null, 2));
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

/**
 * 【step1】Geminiで整形・分類・保存先提案だけを行い、保存はしない（画面で修正してもらう）。
 */
function handleFormatNote_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var rawText = (body.text || '').trim();
  if (!rawText) {
    return { ok: false, error: 'テキストが空です。' };
  }
  var config = getConfig_();
  var folders = listVaultFolders_(false);
  var structured = structureWithGeminiTemplate_(rawText, folders.map(function (f) { return f.path; }));

  var suggested = findFolderByPath_(folders, structured.folder);
  var dailyPath = '';
  for (var i = 0; i < folders.length; i++) {
    if (folders[i].id === config.DAILY_FOLDER_ID) { dailyPath = folders[i].path; break; }
  }
  return {
    ok: true,
    draft: structured,
    suggestedFolder: suggested ? suggested.path : '',
    dailyFolder: dailyPath,
    defaultFolder: config.DEFAULT_NOTE_FOLDER
  };
}

/**
 * 【step2】画面で修正された内容（draft）を保存する。
 * folder が 00_Daily の場合はDaily追記のみ、空なら既定フォルダ。
 */
function handleSaveNote_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var d = body.draft || {};
  var arr = function (v) {
    return Array.isArray(v) ? v.map(function (x) { return String(x).trim(); }).filter(Boolean) : [];
  };
  var draft = {
    title: String(d.title || '').trim() || 'メモ',
    body: String(d.body || ''),
    tags: arr(d.tags),
    projects: arr(d.projects),
    workLog: arr(d.workLog),
    deployDone: !!d.deployDone,
    leftover: arr(d.leftover)
  };
  var rawText = String(body.rawText || '').trim();
  if (!draft.body.trim() && !draft.projects.length && !draft.workLog.length && !draft.leftover.length && !draft.deployDone) {
    return { ok: false, error: '保存する内容が空です。' };
  }
  return saveDraft_(draft, rawText, String(body.folder || '').trim());
}

/** 旧方式（整形→即保存）。互換のため残す。 */
function handleSubmitNote_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var rawText = (body.text || '').trim();
  if (!rawText) {
    return { ok: false, error: 'テキストが空です。' };
  }
  var folders = listVaultFolders_(false);
  var structured = structureWithGeminiTemplate_(rawText, folders.map(function (f) { return f.path; }));
  return saveDraft_(structured, rawText, (body.folder || '').trim() || structured.folder);
}

/** draft を、指定フォルダ（パス）へのノート保存＋当日Daily追記として保存する共通処理。 */
function saveDraft_(draft, rawText, folderPath) {
  var config = getConfig_();
  var folders = listVaultFolders_(false);

  var target = findFolderByPath_(folders, folderPath);
  if (!target) target = findFolderByPath_(folders, config.DEFAULT_NOTE_FOLDER);
  if (!target) {
    var root = getVaultRoot_();
    target = { path: '(ボルト直下)', id: root.getId() };
  }

  var now = new Date();
  var todayFileName = formatDateForFile_(now) + '.md';
  var isDailyOnly = (target.id === config.DAILY_FOLDER_ID);

  // Daily追記用にコピー（リンク行追加で draft 自体を書き換えない）
  var daily = {
    projects: draft.projects.slice(),
    workLog: draft.workLog.slice(),
    deployDone: draft.deployDone,
    leftover: draft.leftover.slice()
  };

  var savedNote = null;
  if (!isDailyOnly) {
    savedNote = saveFormattedNote_(target, draft, rawText, now);
    daily.workLog.unshift('[[' + savedNote.baseName + ']]（📁 ' + target.path + '）');
  } else if (!daily.projects.length && !daily.workLog.length && !daily.leftover.length && draft.body.trim()) {
    // Dailyのみで分類項目が空なら、整形本文を作業ログに残す
    draft.body.split('\n').forEach(function (l) {
      var t = l.replace(/^\s*([-*]|\d+\.|#+)\s*/, '').trim();
      if (t) daily.workLog.push(t);
    });
  }

  var updatedContent = appendToDailyNoteTemplate_(todayFileName, daily);

  return {
    ok: true,
    fileName: todayFileName,
    appended: buildSummaryText_(daily),
    noteContent: updatedContent,
    savedNote: savedNote ? {
      folder: target.path,
      fileName: savedNote.fileName,
      fileId: savedNote.fileId,
      content: savedNote.content,
      url: savedNote.url
    } : null
  };
}

/**
 * 保存済みノート（fileId）を、画面で修正した全文で上書きする。
 * 安全のため、ボルト内フォルダにある .md ファイルのみ許可。
 */
function handleUpdateSavedNote_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  if (!body.fileId || typeof body.content !== 'string') {
    return { ok: false, error: '保存する内容がありません。' };
  }
  var file;
  try {
    file = DriveApp.getFileById(body.fileId);
  } catch (e) {
    return { ok: false, error: 'ノートが見つかりません（削除された可能性があります）。' };
  }
  if (!/\.md$/i.test(file.getName())) {
    return { ok: false, error: 'このファイルは編集できません。' };
  }
  var allowed = {};
  allowed[getVaultRoot_().getId()] = true;
  listVaultFolders_(false).forEach(function (f) { allowed[f.id] = true; });
  var parents = file.getParents();
  var inVault = false;
  while (parents.hasNext()) {
    if (allowed[parents.next().getId()]) { inVault = true; break; }
  }
  if (!inVault) {
    return { ok: false, error: '健二保管庫の外のファイルは編集できません。' };
  }
  file.setContent(body.content);
  return { ok: true, fileName: file.getName(), content: body.content };
}

/**
 * Geminiが整えたノートを、指定フォルダに新規Markdownファイルとして保存する。
 * ファイル名: yyyy-MM-dd_HHmm_タイトル.md（重複時は _2, _3...）
 */
function saveFormattedNote_(target, structured, rawText, now) {
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd_HHmm');
  var title = sanitizeFileName_(structured.title || 'メモ');
  var folder = DriveApp.getFolderById(target.id);

  var baseName = stamp + '_' + title;
  var n = 2;
  while (folder.getFilesByName(baseName + '.md').hasNext()) {
    baseName = stamp + '_' + title + '_' + n;
    n++;
  }
  var fileName = baseName + '.md';

  var tags = (structured.tags || []).map(function (t) {
    return String(t).replace(/^#/, '').replace(/\s+/g, '_');
  }).filter(Boolean);

  var created = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss");
  var daily = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  var content =
    '---\n' +
    'created: ' + created + '\n' +
    'source: obsidian-daily-poster\n' +
    'daily: "[[' + daily + ']]"\n' +
    'tags: [' + tags.join(', ') + ']\n' +
    '---\n\n' +
    '# ' + (structured.title || 'メモ') + '\n\n' +
    (structured.body || rawText).trim() + '\n\n' +
    '> [!quote]- 元の入力（音声認識テキスト）\n' +
    rawText.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n';

  var file = folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
  return { baseName: baseName, fileName: fileName, fileId: file.getId(), content: content, url: file.getUrl() };
}

function sanitizeFileName_(name) {
  var s = String(name)
    .replace(/[\\\/:*?"<>|#^\[\]]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 40) s = s.substring(0, 40);
  return s || 'メモ';
}

// ==================== ボルト内フォルダ一覧 ====================

function handleListFolders_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var folders = listVaultFolders_(!!body.refresh);
  return { ok: true, folders: folders.map(function (f) { return f.path; }), version: APP_VERSION };
}

/** ボルトのルートフォルダ（VAULT_FOLDER_ID、未設定なら 00_Daily の親） */
function getVaultRoot_() {
  var config = getConfig_();
  if (config.VAULT_FOLDER_ID) {
    return DriveApp.getFolderById(config.VAULT_FOLDER_ID);
  }
  if (!config.DAILY_FOLDER_ID) {
    throw new Error('DAILY_FOLDER_ID が設定されていません。');
  }
  var parents = DriveApp.getFolderById(config.DAILY_FOLDER_ID).getParents();
  if (!parents.hasNext()) {
    throw new Error('00_Daily の親フォルダ（健二保管庫）が取得できません。VAULT_FOLDER_ID を設定してください。');
  }
  var root = parents.next();
  PropertiesService.getScriptProperties().setProperty('VAULT_FOLDER_ID', root.getId());
  return root;
}

/**
 * ボルト内のフォルダを FOLDER_MAX_DEPTH 階層まで列挙して [{path, id}] を返す。
 * 「.」で始まるフォルダ（.obsidian / .trash 等）と「_」で始まるフォルダ（テンプレート等）は除外。
 */
function listVaultFolders_(forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    var cached = cache.get(FOLDER_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* 再取得 */ }
    }
  }
  var root = getVaultRoot_();
  var result = [];
  var queue = [{ folder: root, path: '', depth: 0 }];
  while (queue.length && result.length < FOLDER_MAX_COUNT) {
    var cur = queue.shift();
    if (cur.depth >= FOLDER_MAX_DEPTH) continue;
    var it = cur.folder.getFolders();
    var children = [];
    while (it.hasNext()) {
      var f = it.next();
      var name = f.getName();
      if (/^[._]/.test(name)) continue;
      children.push(f);
    }
    children.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
    children.forEach(function (f) {
      var p = cur.path ? cur.path + '/' + f.getName() : f.getName();
      result.push({ path: p, id: f.getId() });
      queue.push({ folder: f, path: p, depth: cur.depth + 1 });
    });
  }
  result.sort(function (a, b) { return a.path < b.path ? -1 : 1; });
  try { cache.put(FOLDER_CACHE_KEY, JSON.stringify(result), FOLDER_CACHE_SEC); } catch (e) { /* 大きすぎる場合はキャッシュしない */ }
  return result;
}

function findFolderByPath_(folders, path) {
  if (!path) return null;
  var norm = String(path).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  for (var i = 0; i < folders.length; i++) {
    if (folders[i].path === norm) return folders[i];
  }
  // 末尾フォルダ名だけで一致するものがあれば採用
  for (var j = 0; j < folders.length; j++) {
    var last = folders[j].path.split('/').pop();
    if (last === norm) return folders[j];
  }
  return null;
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
 * 指定日（YYYY-MM-DD）のDailyノートを、送られてきた内容で丸ごと上書き保存する。
 * ファイルが存在しない場合は新規作成する。加筆・修正はフロント側で全文編集して送る方式。
 */
function handleUpdateNoteByDate_(body) {
  var email = verifySession_(body.token);
  if (!email) {
    return { ok: false, error: 'セッションが無効です。再度ログインしてください。' };
  }
  var dateStr = (body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { ok: false, error: '日付の形式が正しくありません（YYYY-MM-DD）。' };
  }
  if (typeof body.content !== 'string') {
    return { ok: false, error: '保存する内容がありません。' };
  }
  var config = getConfig_();
  if (!config.DAILY_FOLDER_ID) {
    throw new Error('DAILY_FOLDER_ID が設定されていません。');
  }
  var folder = DriveApp.getFolderById(config.DAILY_FOLDER_ID);
  var fileName = dateStr + '.md';
  var files = folder.getFilesByName(fileName);
  var file;
  if (files.hasNext()) {
    file = files.next();
    file.setContent(body.content);
  } else {
    file = folder.createFile(fileName, body.content, MimeType.PLAIN_TEXT);
  }
  return { ok: true, fileName: fileName, noteContent: body.content };
}

/**
 * 指定日（YYYY-MM-DD）のDailyノートをゴミ箱に移動する（完全削除ではない）。
 */
function handleDeleteNoteByDate_(body) {
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
    return { ok: false, error: fileName + ' は見つかりませんでした。' };
  }
  var file = files.next();
  file.setTrashed(true);
  return { ok: true, fileName: fileName };
}

/**
 * Geminiに ①入力を読みやすいMarkdownノートに整形 ②保存先フォルダ選択
 * ③Dailyテンプレート4区分への分類 をまとめて行わせ、JSONで受け取る。
 */
function structureWithGeminiTemplate_(rawText, folderPaths) {
  var config = getConfig_();
  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY が設定されていません。');
  }
  folderPaths = folderPaths || [];

  var systemPrompt =
    'あなたはObsidianボルト「健二保管庫」の整理アシスタントです。入力は音声認識の書き起こし（言い淀み・誤変換・句読点なしを含む）またはテキストです。\n' +
    '次の作業を行い、指定のJSON「だけ」を出力してください。前後の説明やコードブロック記号（```）は付けないでください。\n\n' +
    '【作業】\n' +
    '1. 内容を読みやすいMarkdownノートに整える（フィラー「えー」「あの」等の除去、明らかな誤変換の修正、句読点付与、必要なら「## 見出し」や箇条書きで整理）。意味は変えず、情報を勝手に追加しない。\n' +
    '2. ノートの短いタイトル（20文字以内、ファイル名に使える文字のみ）を付ける。\n' +
    '3. 下の【フォルダ一覧】から、このノートを保存するのに最も適したフォルダを1つ選び、一覧の文字列をそのまま返す。\n' +
    '   その日の作業記録・日記的な短いメモで、独立したノートにする価値が薄い場合は「00_Daily」を選ぶ（一覧にあれば）。\n' +
    '   適切なものがなければ空文字 "" にする。\n' +
    '4. 当日のDailyノート用に、テンプレートの4区分へ分類する。\n\n' +
    '【フォルダ一覧】\n' + (folderPaths.length ? folderPaths.map(function (p) { return '- ' + p; }).join('\n') : '（なし）') + '\n\n' +
    '【出力JSON形式】\n' +
    '{\n' +
    '  "title": "ノートタイトル",\n' +
    '  "body": "整形済みのMarkdown本文（タイトル行 # は含めない。改行は\\nで表現）",\n' +
    '  "tags": ["関連タグ（#なし、2〜5個）"],\n' +
    '  "folder": "フォルダ一覧から選んだパス",\n' +
    '  "projects": ["今日触れた/触る予定のプロジェクト名や作業対象（短い箇条書き）"],\n' +
    '  "workLog": ["作業内容・進捗・意思決定（短い箇条書き）"],\n' +
    '  "deployDone": true または false（GASデプロイ版の更新・確認に言及があればtrue）,\n' +
    '  "leftover": ["明日以降に持ち越すタスク（短い箇条書き）"]\n' +
    '}\n\n' +
    '該当がない配列は [] にする。分類に迷う内容は "workLog" に入れる。projects/workLog/leftover は簡潔な体言止め・常体で。';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + config.GEMINI_MODEL +
    ':generateContent?key=' + config.GEMINI_API_KEY;
  var payload = {
    contents: [
      { role: 'user', parts: [{ text: systemPrompt + '\n\n【入力】\n' + rawText }] }
    ],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3 }
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
    // JSONとして解釈できない場合は、原文のまま既定フォルダに保存し、Dailyにも作業ログとして残す
    parsed = { title: 'メモ', body: rawText, tags: [], folder: '', projects: [], workLog: [rawText], deployDone: false, leftover: [] };
  }

  var arr = function (v) { return Array.isArray(v) ? v.filter(Boolean).map(String) : []; };
  return {
    title: String(parsed.title || 'メモ').trim(),
    body: String(parsed.body || rawText),
    tags: arr(parsed.tags),
    folder: String(parsed.folder || '').trim(),
    projects: arr(parsed.projects),
    workLog: arr(parsed.workLog),
    deployDone: !!parsed.deployDone,
    leftover: arr(parsed.leftover)
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
