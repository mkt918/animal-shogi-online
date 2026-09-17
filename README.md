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

## 大会モード(リーグ戦)

`tournament.html` から大会を作成できます(3人以上向け)。

1. 主催者が名前を入力して「大会を作成」→ 4桁の大会コードが発行される
2. 参加者は名前と大会コードを入力して参加(リンク共有でもOK)
3. 主催者が「組み合わせを作って開始」→ 総当たりの対局表が自動生成される(奇数人数は各回戦に休みが出る)
4. 対局表の「対局を始める」を押した人が先手になり、相手は「対局に参加」で入室
5. 対局が終わると結果が自動で大会に反映され、順位表(勝ち3点・引き分け1点)が更新される

トーナメント形式は次フェーズで対応予定です。

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
- `js/app.js` — Firebase連携・UI制御(大会の対局結果を自動反映する処理を含む)
- `tournament.html` / `js/tournament.js` — 大会モードの画面と制御
- `js/tournament-logic.js` — 総当たり組み合わせ生成・順位計算(Firebase非依存)
- `firestore.rules` — Firestoreセキュリティルール
