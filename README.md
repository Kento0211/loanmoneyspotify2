[README.md](https://github.com/user-attachments/files/32103306/README.md)
# Loan Ledger — PIN + encrypted multi-device loan tracker

GitHub Pages向けの静的な貸付・利息管理サイトです。

## 主な機能

- 借りている人の一覧
- 人をクリックして詳細表示
- 借入額 / 現在額 / 利子 / 利率 / 借入日 / 利息更新日を確認
- 同じ月に10日・20日・30日など複数の利息更新日を設定
- カレンダーから更新日を追加
- グループを作成して複数人をまとめる
- グループ共通の金額を設定（空欄なら各人の金額）
- グループ共通の複数更新日を設定
- 毎月の利息TODOリスト
- 支払済み＝緑の✓、未払い＝赤の×
- 支払った金額 / 未払い時点の現在額をTODOで確認
- 返済・利息支払いの履歴
- 月次 / 年次の利息計算
- PCとスマホで同じ暗号化保管庫を共有

## 利息計算のルール

月次の場合、設定した更新日が1回発生するたびに

`対象金額 × 利率 ÷ 100`

を利子として加算します。

たとえば10日・20日・30日を設定すると、1か月に3回更新されます。

支払いは現在残高から差し引きます。利子自体は設定した対象金額を基準に計算します。

## Supabase設定

1. Supabaseでプロジェクトを作成
2. SQL Editorを開く
3. `supabase.sql` を全部実行
4. Settings → API Keysから Project URL と Publishable key (`sb_publishable_...`) を取得
5. `config.js` に入力

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..."
};
```

**`sb_secret_...` は絶対にGitHubへ置かないでください。**

SupabaseのData APIでは、公開するテーブル/関数に必要な権限を明示し、RLSなどでアクセスを制御することが推奨されています。

## 暗号化

貸付データはブラウザ側でJSON化し、PBKDF2 + AES-GCMで暗号化してからSupabaseへ送ります。
暗証コードそのものはSupabaseへ保存しません。

暗証コードを忘れると復号できません。

## PCとスマホ

PCで保管庫を作成すると「共有コード」が発行されます。

スマホ側でその共有コードを入力し、PCと同じ暗証コードを入力すると同じデータを開けます。

## GitHub Pages

以下をリポジトリのルートに置き、GitHub Pagesを `main` / `/(root)` から公開します。

- index.html
- style.css
- app.js
- crypto.js
- config.js
- supabase.sql
- README.md

これは個人用の貸付管理・計算ツールです。金銭の貸し借りに関する法律・利率・税務上の扱いについては別途確認してください。
