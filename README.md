# どうぶつしょうぎ オンライン対戦

Firebase(Firestore + Anonymous Auth)を使ったリアルタイム対戦版どうぶつしょうぎです。
ビルド不要のプレーンHTML/CSS/JSで、GitHub Pagesにそのまま公開できます。

## ルール概要

- 盤面: 3列×4段
- 駒: ライオン🦁 / ゾウ🐘 / キリン🦒 / ヒヨコ🐤(相手最奥列で成りニワトリ🐔)
- 勝利条件: 相手のライオンを取る、または自分のライオンが相手陣最奥列に到達する(トライルールの簡易版・生存確認なし)
- 取った相手の駒は持ち駒になり、自分の手番に盤上の空きマスへ打てます

## セットアップ手順

### 1. Firebaseプロジェクトを作成

1. https://console.firebase.google.com/ で新規プロジェクトを作成
2. 「Authentication」→「Sign-in method」で **匿名(Anonymous)** を有効化
3. 「Firestore Database」を作成(本番モードでOK。ルールは後で設定)
4. 「プロジェクトの設定」→「マイアプリ」でウェブアプリを追加し、表示された設定値を控える

### 2. 設定ファイルを編集

[js/firebase-config.js](js/firebase-config.js) の `firebaseConfig` を、controlしているFirebaseプロジェクトの値に置き換えてください。

### 3. Firestoreセキュリティルールを設定

Firebaseコンソールの Firestore →「ルール」タブに [firestore.rules](firestore.rules) の内容を貼り付けて公開してください。
(Firebase CLIを使う場合は `firebase deploy --only firestore:rules`)

### 4. GitHubで公開(GitHub Pages)

```bash
git init
git add .
git commit -m "Initial commit: どうぶつしょうぎ"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

その後、GitHubリポジトリの Settings → Pages で、Source を `main` ブランチ / `/ (root)` に設定すると、
`https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

## 遊び方

1. 公開されたページを開くと匿名ログインが行われます
2. 「新しい部屋を作成」を押すと6文字の部屋コードが発行されます(自分が先手になります)
3. 「🔗リンクをコピー」で招待リンクを相手に送るか、部屋コードを伝えます
4. 相手が部屋コードを入力して参加すると対局開始(後手になります)
5. 自分の駒 or 持ち駒をクリックして選択 → ハイライトされたマスをクリックで移動・打つ

## ローカルでの動作確認

Firebase SDKをCDNから読み込んでいるため、`index.html` をローカルサーバー経由で開いてください(file://だとCORS等で失敗する場合があります)。

```bash
npx serve .
# もしくは
python -m http.server 8000
```

## ファイル構成

- `index.html` — ロビー/対局画面
- `css/style.css` — スタイル
- `js/game-logic.js` — どうぶつしょうぎのルールエンジン(Firebase非依存の純粋関数群)
- `js/firebase-config.js` — Firebaseプロジェクトの設定(要編集)
- `js/app.js` — Firebase連携・UI制御
- `firestore.rules` — Firestoreセキュリティルール
