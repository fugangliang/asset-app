# CLAUDE.md — 資産ダッシュボードPWA（asset-app）

iPhoneで使う個人資産管理PWA。銘柄・購入（日付/数量/単価）・毎月積立（NISA/iDeCo）を入力し、
時価の自動取得・チャート・損益・IRRを表示する。2026-11-24 新規作成（旧 `~/Documents/cfo-app/` は廃止・置換）。

## 構成（2リポジトリ）

| 場所 | 役割 | 公開範囲 |
|---|---|---|
| `~/Documents/asset-app/`（本repo・`docs/`=GitHub Pages） | アプリ本体（静的PWA・ビルドなし） | 公開可（個人データを含まない） |
| `~/Documents/asset-app-data/`（repo `asset-app-data`） | 銘柄一覧 `watchlist.json`・価格履歴 `prices/`・`status.json`・投信一覧 `funds_index.json`・暗号化バックアップ `backup.enc.json`・取得スクリプト `fetch_prices.py`＋Actions | **非公開**（保有銘柄が分かるため） |

- 入力データ（数量・金額）はiPhone内 localStorage のみ。パスフレーズ設定時のみ AES-256-GCM で暗号化して data repo にバックアップ。
- 時価は data repo の GitHub Actions が1日3回（JST 7:30/21:30/23:30）＋ `watchlist.json` 変更時に取得。iPhoneは Fine-grained PAT（Contents RW・data repoのみ）で読む。
- 取得元: 投信=投資信託協会CSV（設定来）、米国株=Nasdaq API（過去約10年・失敗時Yahoo）、為替=Frankfurter（ECB参照レート）。すべて終値。

## 絶対規則

- 金額計算は `docs/logic.js` のみ（純関数）。`app.js` で再実装しない。変更時は `node --test test/logic.test.js` を通す。
- 本repoに個人データ（保有銘柄・数量・金額・トークン）を入れない。デモデータは一般的な銘柄の架空数量のみ。
- 価格取得の失敗を握りつぶさない（`status.json` に記録し、アプリでバナー表示）。
- `docs/` を変更したら `sw.js` と `app.js` の `VERSION` を同時に上げる（キャッシュ優先のため上げないとiPhoneに反映されない）。
- data repo は非公開のまま。公開repoへの変更・remote追加はRF確認後。

## コマンド

- テスト: `node --test test/logic.test.js`
- ローカル確認: `docs/` と data repo を同一サーバで配信し `index.html?demo=1&dev=/data/`（demo=架空データ・dev=GitHubの代わりに静的ファイルを読む・書込なし）
- 価格取得の手動実行: data repo で `python3 fetch_prices.py`（`--index` で投信一覧も再取得）

## 既知の制約・[要確認]

- 売却・分配金・配当・税は未対応（IRRは「購入を出金・現在評価額を入金」とみなした年率）。
- 積立の口数は「引落日以降の最初の営業日＋N営業日後の基準価額」での推定。実数は「現在の保有口数」で補正できる。
- `[要確認]` iDeCoの既定値（約定まで12営業日・手数料171円/月）は一般的な目安。RFの金融機関の実態で調整要。
- `[要確認]` 米国株の株式分割: 価格履歴は分割調整済みのため、分割前の購入は分割後の株数・単価で入力する必要がある。
- 米国株の価格履歴は約10年分。それ以前の購入は単価・為替の手入力が必要（空欄の自動適用不可）。

## 進捗（確定事項ログ）

- 2026-11-24: v1.0.0 作成。RF裁定=cfo-app廃止・置換／時価はGitHub Actions／対象は投信＋米国株／銘柄一覧は非公開。ロジックテスト14件通過、デモデータで全画面を確認。
- 2026-11-24: 公開（RF承認「コードのみの配信はOK」）。本体=github `fugangliang/asset-app`（public）・配信=https://fugangliang.github.io/asset-app/ 。データ=`fugangliang/asset-app-data`（private）。Actions初回実行で投信・米国株（Nasdaq）・為替とも取得成功を確認（ghに workflow スコープ追加済み）。RF残作業=iPhoneでFine-grained PAT作成→設定画面に登録→ホーム画面に追加。`[要確認]` iPhone実機での動作（入力・チャートのタッチ操作・バックアップ）。
- 2026-11-24（続き）: v1.0.1＝設定画面にトークン作成リンク（入力済みURL）を追加・公開済み。RFがiPhoneで初期設定（Fine-grained PAT登録・接続テスト・ホーム画面追加）を完了。銘柄の登録はこれから。
- 繰越: ①RFが最初の銘柄を登録後、Actionsが新銘柄の価格を取得するか（watchlist.json の自動更新→push→取得）を実機で確認 `[要確認]` ②iPhone実機でのチャートのタッチ操作・バックアップ往復 `[要確認]` ③iDeCo既定値・株式分割・米国株10年超の手入力（上記「既知の制約」）④ローカルの `asset-app-data` はアプリ/Actionsがリモートを更新するため、作業前に `git pull` すること。
