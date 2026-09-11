# Loan Ledger — PIN + AES-GCM encrypted sync

GitHub Pages向けの静的サイトです。

## できること

- 貸付相手・元金・利率・更新日を管理
- 月次 / 年次の利子計算
- カレンダーで更新日を確認
- 暗証コードでデータを暗号化
- Supabaseへ暗号化データを保存
- PCとスマホで同じ保管庫を共有
- メールアドレスやパスワードのログイン不要

## 重要なセキュリティ仕様

ブラウザ側で貸付データ全体をJSON化し、Web Crypto APIの
PBKDF2 + AES-GCMで暗号化してからSupabaseへ送ります。

Supabaseに保存されるのは、

- 暗号化されたデータ
- salt
- IV
- 暗号化方式のバージョン

です。

暗証コードはSupabaseへ送信・保存しません。

**暗証コードを忘れた場合、復元できない設計です。**
また、共有コードも別の端末で開くために必要です。

## 1. Supabaseを設定

Supabaseでプロジェクトを作成します。

1. SQL Editorを開く
2. `supabase.sql` の内容を全部実行
3. Settings → API Keysから
   - Project URL
   - Publishable key (`sb_publishable_...`)
   を取得
4. `config.js` に入力

例:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..."
};
```

**`sb_secret_...` は絶対に入れないでください。**

## 2. GitHub Pages

以下をリポジトリのルートへ置きます。

- index.html
- style.css
- app.js
- crypto.js
- config.js
- supabase.sql
- README.md

GitHub Pagesを `main` / `/(root)` から公開します。

## 3. 初回

「暗号保管庫」→暗証コードを設定。

保管庫を作成するとランダムな「共有コード」が発行されます。

## 4. スマホを追加

PC側の「暗号保管庫」から共有コードを表示して、スマホ側で

「暗号保管庫」→「別の端末を追加する」

から共有コードを入力します。

その後、PCで設定した暗証コードを入力します。

## 5. データの流れ

```text
貸付データ
   ↓
JSON化
   ↓
PIN + PBKDF2
   ↓
AES-256-GCM
   ↓
Supabase
```

Supabaseから取得したデータも、ブラウザ内で暗証コードを使って復号します。

## 注意

これは個人用の貸付管理・計算ツールです。
金銭の貸し借りに関する法律・利率・税務上の扱いについては別途確認してください。
