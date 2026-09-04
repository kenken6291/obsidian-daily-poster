# Obsidian Daily Poster セットアップ手順

音声/テキストで投稿した内容を Gemini API で整形し、Google ドライブ上の Obsidian ボルトの
「00_Daily/YYYY-MM-DD.md」に自動追記するシステムです。

構成: GitHub Pages（`index.html`）+ GAS（`Code.gs`）の JSON API 構成。

---

## 1. Google ドライブ側の準備

1. Obsidian ボルトが Google ドライブで同期されていることを確認します（Google Drive デスクトップアプリ等）。
2. ボルト内の `00_Daily` フォルダを開き、ブラウザのアドレスバーからフォルダIDを控えます。
   - URL例: `https://drive.google.com/drive/folders/【ここがフォルダID】`

## 2. GAS プロジェクトの作成

1. [script.google.com](https://script.google.com) で新規プロジェクトを作成します。
2. デフォルトの `コード.gs`（または `Code.gs`）の中身を、本パッケージの `Code.gs` の内容で置き換えます。
3. 左メニューの「プロジェクトの設定」→「スクリプト プロパティ」で以下を追加します。

   | プロパティ名 | 値 |
   |---|---|
   | `GEMINI_API_KEY` | Gemini APIキー |
   | `DAILY_FOLDER_ID` | 手順1で控えた `00_Daily` フォルダのID |

   ※ `USER_SHEET_ID` は未設定でOK。初回のユーザー登録時に自動でスプレッドシート
   （`ObsidianDailyPoster_Users`）が作成され、自動的に登録されます。

4. 「デプロイ」→「新しいデプロイ」を選択します。
   - 種類: 「ウェブアプリ」
   - 説明: 任意（例: v1）
   - 次のユーザーとして実行: 「自分」
   - アクセスできるユーザー: 「全員」
5. デプロイ後に表示される **ウェブアプリのURL**（`https://script.google.com/macros/s/.../exec`）を控えます。
6. 初回はGoogleの承認画面が出るので、Drive・スプレッドシートへのアクセスを許可します。

### Gemini APIキーの取得方法
[Google AI Studio](https://aistudio.google.com/app/apikey) にアクセスし、「Create API key」からキーを発行してください。

## 3. フロントエンド（GitHub Pages）の設定

1. `index.html` を任意のGitHubリポジトリに配置します。
2. `index.html` 内の以下の行を、手順2-5で控えたウェブアプリURLに書き換えます。

   ```js
   const GAS_API_URL = 'https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec';
   ```

3. リポジトリの Settings → Pages で GitHub Pages を有効化し、公開されたURLにアクセスします。

## 4. 動作確認

1. 公開されたサイトにアクセスし、「会員登録」からメールアドレス・パスワード（6文字以上）で登録します。
2. ログイン後、投稿画面が表示されます。
3. 「🎙️ 音声入力を開始」を押して日本語で話すか、テキスト欄に直接入力します。
4. 「Dailyノートに追記」を押すと、Geminiが整形したMarkdownが `00_Daily/本日の日付.md` に追記されます。
   ファイルが存在しない場合は自動的に新規作成されます。

## 補足・注意事項

- **音声認識** は Web Speech API（`SpeechRecognition`）を使用しており、**Chrome系ブラウザでの動作を推奨**します（Safari/Firefoxは非対応/挙動が異なる場合があります）。
- ログインセッションは `CacheService` で管理しており、**有効期限は最大6時間**です（アクセスのたびに自動延長）。長時間放置すると再ログインが必要です。
- パスワードは salt 付きHMAC-SHA256でハッシュ化してスプレッドシートに保存しています（平文保存はしていません）。
- CORSのプリフライトを避けるため、フロントエンドは `Content-Type: text/plain` でPOSTしています（GASの標準的な回避策です）。
- 追記時に `<!-- HH:mm 投稿 -->` というコメント行を目印として挿入しています。不要な場合は `Code.gs` の `appendToDailyNote_` 内の `block` 変数を調整してください。
