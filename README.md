# TaskFlow (v3 - 機能追加版)

追加された最新機能がすべて盛り込まれています。

- サブタスクのホーム画面展開＆個別完了チェック
- タスク完了時の遅延消去（グレーアウト）と「取り消し」機能
- 多重タップ防止ブロック
- 相対日付（○日後・○週間後）の手入力UI
- 毎週○曜日の繰り返しタスク機能
- 全データ消去機能（設定画面）

## GAS同期

### TaskFlow側の設定

設定画面の「Google Apps Script 同期」に、GAS WebアプリURLとAPIキーの両方を入力して保存します。URLは `https://script.google.com/macros/s/DEPLOYMENT_ID/exec` 形式です。APIキーはGAS側の `TASKFLOW_API_KEY` スクリプトプロパティと同じ値にします。TaskFlowではURLを `taskflowGasSyncUrl`、APIキーを `taskflowGasApiKey` という別々の `localStorage` 項目に保存します。どちらかが未設定なら同期しません。

### GAS側の契約と設定

GASプロジェクトのスクリプトプロパティに `TASKFLOW_API_KEY` を設定し、`doPost(e)` は `JSON.parse(e.postData.contents)` で次の形式を読み取ります。プレースホルダーを実際のAPIキーに置き換え、同じ値をTaskFlowの設定画面にも入力してください。

```json
{
  "apiKey": "YOUR_TASKFLOW_API_KEY",
  "tasks": [
    {
      "id": "TASK_ID",
      "title": "TASK_TITLE",
      "startDate": "",
      "deadline": "",
      "priority": "2",
      "recurring": "none",
      "memo": "",
      "completed": false,
      "extraDates": [],
      "urls": [],
      "images": [],
      "subtasks": [],
      "createdAt": "ISO_8601_TIMESTAMP"
    }
  ]
}
```

`tasks` は変更分ではなくIndexedDB内の全タスク配列です。タスク追加・更新・削除、復元、全消去後に最新状態が送信され、起動時とオンライン復帰時にも全件を送信します。`doPost(e)` ではAPIキーをスクリプトプロパティと照合し、一致した場合だけ `tasks` 配列を処理してください。配列内のタスクには上記以外の追加プロパティが存在する場合もあります。

設定手順: 1) Google SheetsからApps Scriptを作成します。2) Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に `TASKFLOW_API_KEY` と自分で生成したキーを登録します。3) `doPost(e)` を実装し、リクエスト本文のキーを照合してから `tasks` をシートへ反映します。4) Webアプリとしてデプロイし、URLをTaskFlowに登録します。TaskFlowはクロスオリジン認証情報を送らないため、GASは匿名リクエストを受け付けるアクセス設定が必要です（例: Webアプリのアクセス対象を「全員」にする）。実際の組織ポリシーに従ってください。

### 通信・セキュリティ上の注意

TaskFlowは `POST`、`Content-Type: text/plain;charset=UTF-8`、`mode: no-cors` で本文を送ります。GAS側は `e.postData.contents` をJSONとして解析してください。CORS応答を読み取れないため、TaskFlowはHTTPステータスやGASの処理結果を確認できず、送信要求が完了してもGAS側の成功を保証しません。受信・エラーはGAS側で確認してください。通信失敗時もIndexedDBへの保存は継続し、失敗分の永続キューはなく、オンライン復帰時または次の変更時に再送します。

APIキーはURLやログには含めませんが、ブラウザーの `localStorage` に保存され、端末利用者や侵害されたアプリページから読み取られる可能性があります。また匿名アクセス可能なWebアプリでは、キーが漏れると第三者が呼び出せます。専用のキーを使い、他の重要な認証情報を流用しないでください。この方式は完全な認証・保護ではありません。Google Sheetsへの書き込み、定期リマインダー/Gmail通知のGAS側実装はこのアプリには含まれません。
