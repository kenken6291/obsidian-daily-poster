/**
 * Obsidian Daily Poster - 設定ファイル
 * GASを再デプロイして「新しいデプロイ」でURLが変わった場合は、ここだけ書き換えてください。
 * （「デプロイを管理」→ 編集 → 新バージョン の場合はURLは変わりません）
 */
window.APP_CONFIG = {
  // GASウェブアプリのURL（.../exec）
  GAS_API_URL: 'https://script.google.com/macros/s/AKfycby89KUiJBfEt1yW_BrOqRKhSRhg06y2HFjV9ZPbf5Vp7y8fxiNZsvtjlz3D8V3ohhhf/exec',

  // 既定のGeminiモデル（画面で選ばなかった時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「AIモデル」選択肢（value がAPIのモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' }
  ]
};
