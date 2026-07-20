# Cloud WAN マルチリージョン NFG フェイルオーバー

AWS Cloud WAN の複数リージョン NFG (Network Function Group) アタッチメント構成で、Network Firewall (以下 NFW) / NAT Gateway の障害時に自動フェイルオーバーを行う検証用の CDK プロジェクトである。

- **片方の AZ が障害 / もう片方が健全** → 健全な AZ へ経路を切り替える (Inspection VPC の Cloud WAN アタッチメントサブネットのルートテーブルのネクストホップを `ReplaceRoute` で付け替え)
- **両方の AZ が障害** → 別リージョンの NFG をネクストホップにする。どの障害パターンに対しても with-edge-overrides を機械生成できるようにし、検出した障害に対応する override を生成して Cloud WAN ポリシーへ適用する
- **全 NFG リージョンが障害** → fail-close する。fail-close はポリシーを変更せずログ記録のみを行う。直前の override が障害中の NFG を指したままになるため経路はブラックホール化し、検査できない通信は通らない

RTO は障害発生 (検査経路の停止) から迂回完了 (ポリシー反映完了による通信回復) までとし、目標は 30 分とする。復旧は手動で行う。

## アーキテクチャ

### リージョン構成 (各 2 AZ)

| リージョン | 略称 | 優先度 | 役割 |
| --- | --- | --- | --- |
| us-east-1 | use1 | 1 | NFG あり <br>- Inspection VPC <br>- HealthCheck VPC <br>- Workload VPC x2 |
| ap-northeast-1 | apne1 | 7 | NFG あり <br>- Inspection VPC <br>- HealthCheck VPC <br>- Workload VPC x2 |
| ap-northeast-3 | apne3 | 9 | NFG あり <br>- Inspection VPC <br>- HealthCheck VPC <br>- Workload VPC x2 |
| us-west-2 | usw2 | 4 | NFG なし <br>- Core Network ホーム <br>- オーケストレーター <br>- Workload VPC x2 |
| ap-southeast-1 | apse1 | 11 | NFG なし <br>- Workload VPC x2 (両端 NFG なしペアの観測用) |

優先度は Cloud WAN の default Region priority list の番号 (小さいほど優先)。リージョンごとの番号一覧は公式ドキュメントに掲載がなく、この値は [What is AWS Cloud WAN](https://docs.aws.amazon.com/network-manager/latest/cloudwan/what-is-cloudwan.html) の Region availability テーブルの掲載順から導出した。このうち「両端 NFG なし → 優先度 1 位」は実機検証の項目 18 で観測する。NFG リージョン間の相対順位は、平常時のペアごとのデフォルト検査先を Network Firewall の ALERT ログで観測して裏取りできる。

### Stack

| Stack | リージョン | 役割 |
| --- | --- | --- |
| `NfgFailoverCoreStack` | us-west-2 | GlobalNetwork + CoreNetwork + baseline ポリシー |
| `NfgFailoverRegionStack-<region>` | 各 | Workload VPC (全リージョン) <br>NFG リージョンには Inspection VPC / HealthCheck VPC を追加 |
| `NfgFailoverOrchestratorStack` | us-west-2 | Step Functions (以下 SFN) の JSONata ステートマシン + EventBridge Scheduler |
| `NfgFailoverMonitoringStack` | us-west-2 | 運用ダッシュボード + カスタムメトリクス参照 |

合計 8 スタック (CoreStack 1 + RegionStack 5 + OrchestratorStack 1 + MonitoringStack 1) で構成される。
デプロイ順序は CoreStack → RegionStack 5 本 (並列) → OrchestratorStack → MonitoringStack である。
全 Stack で `crossRegionReferences: true` を設定し、`addDependency` で順序を担保する。

### フェイルオーバーの流れ

```text
EventBridge Scheduler (3 分間隔)
  -> Step Functions (JSONata)
       1. 全 NFG リージョン x 各 AZ のヘルスチェック Lambda を CallAwsServiceCrossRegion で並列実行
          (応答なし / 異常は Catch で unhealthy に正規化)
       2. Aggregate (JSONata): avoidRegions / replaceTargets / failoverTarget / failClose を算出
       3. 異常検知時のみ確認再測定: 90 秒待って 2 回目のヘルスチェックを行い、2 回とも unhealthy の
          AZ だけを障害と確定 (瞬断の誤検知で不可逆アクションを起こさない。平常時は再測定を行わず次へ進む)
       4. Parallel:
          (a) 片 AZ 障害リージョン -> DescribeRouteTables -> ReplaceRoute (健全な AZ の NFW エンドポイントへ)
          (b) 両 AZ 障害 -> LIVE ポリシーが目標ポリシーと一致すればスキップ (冪等)
               -> 不一致なら with-edge-overrides を生成 (send-to は per-edge に生成し、各エッジの
                  優先 NFG が健全ならそれを維持し、avoid 中なら次点へ。send-via は
                  障害中の NFG に向かうペアのみ健全側へ per-pair 生成)
               -> PutCoreNetworkPolicy -> 生成完了 (READY_TO_EXECUTE) を待つ
               -> ExecuteCoreNetworkChangeSet -> 実行完了をポーリング
                  (上限到達時は正常終了して次サイクルが引き継ぐ。実行はサーバー側で継続)
          (c) 全 NFG 障害 (failClose) -> ログのみ
```

自作の Lambda は **ヘルスチェックのみ** (Python 3.14)。集計 / ルート操作 / ポリシー操作はすべて JSONata SFN + AWS SDK 統合で実装している (cross-region 操作は CDK 生成の Singleton proxy Lambda を経由)。

## ヘルスチェック仕様

| 項目 | 値 |
| --- | --- |
| 方式 | TCP 接続チェック (`socket`) |
| 疎通先 | tier 1 (AWS 管理): <br>- `amazonaws.com` の NS レコードを実行時に解決した権威 DNS サーバー群 (TCP/53) <br>- `checkip.amazonaws.com:443` <br>tier 2 (最終フォールバック): tier 1 の全エンドポイントが失敗した場合のみ試行 <br>- `1.1.1.1:53` / `8.8.8.8:53` (IP 直指定で DNS 非依存) |
| 試行回数 | 各エンドポイント 3 回 <br>tier 内は並列 <br>1 回でも成功すれば正常と判定 |
| 試行間隔 | 0.3 秒 |
| 接続タイムアウト | 3 秒 / 回 |
| Lambda 実行間隔 | 3 分 (EventBridge Scheduler) |
| 確認再測定 | 1 回目で異常検知時のみ 90 秒後に再測定 <br>2 回とも unhealthy の AZ だけを障害と確定 |
| ランタイム | Python 3.14 |

疎通先は tier 化しており、AWS 管理のエンドポイント (tier 1) から順に試し、前の tier の全エンドポイントが失敗したときだけ次へ進む。平常時にサードパーティ (tier 2) へ接続しないための構成である。tier 1 の権威 DNS サーバーは名前も IP も固定値として埋め込まず、`amazonaws.com` の NS レコードを Lambda 実行時に引いて展開する。全 tier の全エンドポイントの失敗で初めて疎通不可と判定し、宛先側障害による誤検知を防ぐ。`probeEndpointTiers` などは `lib/config.ts` の `FAILOVER` で一元管理し、選定の経緯と checkip.amazonaws.com の出典上の位置づけ (2026-07-19 追記) は [疎通先の調査記録](docs/probe-endpoint-research.md) にある。

## 監視

us-west-2 の CloudWatch ダッシュボード `nfg-failover-operations` に全リージョンの状態を集約している。
行構成は「いま対応が必要か → どのリージョン / AZ に異常があるか → 何が起きて、いまどのポリシーか → 仕組みは動いているか → 検査は流れているか」であり、値の意味と対処は [docs/failure-scenarios.md](docs/failure-scenarios.md) の「実行結果の読み方」を参照する。
カスタムメトリクス (名前空間 `NfgFailover`) はログのメトリクスフィルターで発行しており、本体ロジックには手を入れていない。
tier 2 接触 (サードパーティの疎通先への接続) は平常時 0 が正常値である。

重大事象は CloudWatch アラームで検知する。アラームは us-west-2 の MonitoringStack に定義した 7 種類と、NFG リージョンごとの unhealthy 継続アラーム (リージョン x AZ で 6 個) の計 13 個である。MonitoringStack の 7 種類は次のとおりである。

- fail-close の発生 (FailCloseAlarm)
- SFN 実行失敗 (SfnFailedAlarm)
- 定期実行の停止 (ExecutionStoppedAlarm)
- ReplaceRoute 失敗 (ReplaceRouteFailedAlarm)
- ポリシー切り替えの発生 (PutPolicyAlarm)
- 確認再測定による検知取り消しの頻発 (ConfirmationCanceledAlarm)
- ヘルスチェック基盤側異常 (ProbeInvokeErrorAlarm)

いずれも通知アクションは未設定である。アラーム状態はダッシュボード先頭行に集約表示され、確認は運用者が行う。初回デプロイ後にスケジュールを有効化するまでの間は、定期実行の停止のアラーム (ExecutionStoppedAlarm) が ALARM 状態のままになるが、これは想定内である。
検知スコープは「NFG リージョンの検査経路」である。エッジ間の Cloud WAN 経路障害や非 NFG リージョン (usw2 / apse1) 発の経路障害はヘルスチェックの検知対象外で、この仕組みではフェイルオーバーしない。

## 設計の前提となる default Region priority list の挙動

以下は過去の別検証で実機確認した挙動であり、リージョンフェイルオーバー設計はこれを前提とする。

- use-edge-location を指定しなくても、複数リージョンに NFG があると優先度 #1 (us-east-1) が選ばれる
- デタッチしても自動フォールバックせず、宛先へのトラフィックが破棄されるブラックホールの状態になる。ルート再評価には Core Network Policy の再適用が必須である
- そのため障害リージョンを参照する経路の選択先を上書きする override が必要である。send-to (インターネット向け egress) と send-via (VPC 間 east-west) は対象トラフィックが異なる別のアクションであり、片方だけを上書きしてももう片方はデフォルトの優先度に従ってしまう。このため障害リージョンを避けるには両方の override を生成する必要がある
  - send-to は per-edge に生成し、各エッジの優先 NFG (NFG あり = 自身 / NFG なし = 最近傍) が健全ならそれを維持し、優先 NFG が avoid に含まれる場合のみ次点 (failoverTarget) へ向ける
  - send-via は per-pair の最小 override である方式 C で生成する。方式 C は、デフォルトの経路選択が障害中の NFG に向かうペアだけを個別に健全側へ上書きし、健全リージョンのローカル検査を維持する方式である。実機検証で apne1 ダウン時に apne3 のローカル検査が維持されることを FIB で確認済み (実機検証 13 / 14)
  - 方式 C が依存する未文書挙動 (エントリ重複 / set 外 use-edge-location / カバー外フォールバック) は実機検証 13 / 14 で受理と正常動作を確認済み。single-set への切り戻しは不要であるが、`lib/config.ts` の `SEND_VIA_OVERRIDE_MODE` は念のため保持する
- egress のデフォルトは全エッジ → #1 のため、baseline ポリシーに send-to の per-edge override を常設する。この常設 override は、ヘルスチェックの通信が自リージョンの NFG を通過するようにするための機能要件であり、非 NFG リージョンは最近傍の NFG (us-west-2 → us-east-1 / ap-southeast-1 → ap-northeast-1) へ向ける
- baseline に RFC1918 の全レンジのブラックホール静的ルートを常設する。ネットワーク内に存在しない RFC1918 宛が send-to の 0.0.0.0/0 に乗って Inspection VPC と往復することを防ぐ。実在する VPC の CIDR は伝播ルートがロンゲストマッチにより優先されるため通信に影響しない。全状態の FIB で 10.0.0.0/8 / 172.16.0.0/12 / 192.168.0.0/16 が BLACKHOLE、実在 /16 が PROPAGATED ACTIVE で共存することを確認済み

優先度テーブルは `lib/config.ts` を唯一のソースとし、`failoverTargetRegion(avoidRegions)` で次点を計算する。多段フェイルオーバー例: us-east-1 障害 → ap-northeast-1、さらに ap-northeast-1 も障害 → ap-northeast-3、全 3 障害 → fail-close。

## デプロイ

前提として次のツールを使用する (package.json にバージョン指定はない)。

- Node.js
- pnpm
- AWS CLI
- jq

```bash
# AWS 認証情報を設定する (使用するツールは問わない)
# 設定後に対象アカウントを確認する
aws sts get-caller-identity

# 依存解決
pnpm install

# 5 リージョンへ Bootstrap (初回のみ。<ACCOUNT_ID> はデプロイ先アカウントの ID に置き換える)
for r in us-west-2 us-east-1 ap-northeast-1 ap-northeast-3 ap-southeast-1; do
  pnpm cdk bootstrap aws://<ACCOUNT_ID>/$r &
done
wait

# 差分確認 / デプロイ
pnpm cdk diff
pnpm cdk deploy \
  --all \
  --concurrency 8 \
  --require-approval never

# デプロイ完了後、各 NFG リージョン (us-east-1 / ap-northeast-1 / ap-northeast-3) の
# ヘルスチェック Lambda を直接実行し、全 6 関数 (3 NFG リージョン x 2 AZ) が
# "healthy": true を返すことを確認する。直接実行はログ経由で ProbeHealthy メトリクスも
# 記録するため、ダッシュボード nfg-failover-operations の全 6 系列 (3 NFG リージョン x 2 AZ) も
# この操作で確認できる。関数名は CDK 生成のため、Probe を含む関数名を列挙して実行する
for region in us-east-1 ap-northeast-1 ap-northeast-3; do
  for fn in $(aws lambda list-functions \
    --region "$region" \
    --query "Functions[?contains(FunctionName, 'Probe')].FunctionName" \
    --output text); do
    aws lambda invoke \
      --region "$region" \
      --function-name "$fn" \
      /dev/stdout
  done
done

# 全 6 関数が healthy になったことを確認してから、定期実行を有効化する
aws scheduler get-schedule \
  --name nfg-failover-health-check \
  --region us-west-2 \
  | jq 'del(.Arn, .CreationDate, .LastModificationDate) | .State = "ENABLED"' \
  > /tmp/schedule.json
aws scheduler update-schedule \
  --cli-input-json file:///tmp/schedule.json \
  --region us-west-2
```

スケジュールは無効状態でデプロイされる。デプロイ直後は Cloud WAN のルート伝播が未完了で、リージョン間の立ち上がり速度差により健全なリージョンが誤って回避対象 (avoid) になり得る。一度回避対象になると手動復旧まで戻らない。そのため疎通の確立を確認してから起動する。update-schedule は全プロパティ上書き型のため、get-schedule の出力を加工して渡す。なお、SFN の手動実行による疎通確認は行わない。ルート伝播が未完了の状態で実行すると、異常判定から avoid が確定して手動復旧が必要になるためである (スケジュール有効化を待つ理由と同じ)。

初回デプロイは 16 本のアタッチメントを並列作成するため、Cloud WAN 側の change event 処理が集中する。内訳は Workload VPC が 5 リージョン x 2 本 = 10 本、NFG 3 リージョンの Inspection VPC と HealthCheck VPC が 3 x 2 = 6 本である。デプロイがアタッチメント作成で長時間停滞した場合は、変更イベントの処理キューの集中を疑い、完了を待つ (自動回復する)。懸念がある場合は `--concurrency 1` で順にデプロイしてもよい。

VPC の AZ は `lib/config.ts` の `availabilityZones` に明示固定している。context lookup を使わないため、`cdk.context.json` がない環境でも synth は決定論的に成功する。AZ 名が指す物理 AZ はアカウントごとに異なるため、別アカウントへ転用する場合は値を見直すこと。

## 実機検証 (デプロイ後)

障害シナリオ全 27 パターンの期待動作と TestState API による検証結果は [docs/failure-scenarios.md](docs/failure-scenarios.md) を参照。JSONata の集計 / override 生成 / 冪等判定は TestState で検証済み。残る AWS 側挙動は実機で確認する。一部の項目は机上または API 実測で確認済みであり、その旨を項目内に記載している。SFN の実行ログ (CloudWatch Logs の `level: ALL`) を確認しながら切り分ける。

注意: EC2 Instance Connect Endpoint は各 Workload VPC の AZ-a サブネットに 1 つだけ置いている (VPC あたり 1 個の制約)。AZ-a の障害を模擬している間は、その VPC の EC2 への管理アクセスも失われるため、AZ-a 側の障害模擬はテスト用 EC2 の操作を先に済ませてから行う。

1. **同一 AZ 固定 (AZ pinning)**
   各 AZ のヘルスチェック Lambda が自 AZ の NFW / NAT を通るかを NFW FLOW ログで確認
2. **with-edge-overrides が default priority より優先されるか**
   手動でポリシーを切り替え、障害リージョンを避けて検査されるかを NFW ALERT ログ (`INSPECTED at <region>`) で確認
3. **cross-region Lambda invoke の Payload 形式**
   proxy Lambda はパース済みオブジェクトを返す前提である (aws-cdk-lib のハンドラーソースで確認済み)。実機でも集計ステップの healthy 判定式が想定する形式で返るかを確認する
4. **ReplaceRoute の NFW エンドポイント抽出**
   `DescribeRouteTables` 応答のルートテーブル (RT) タグ `failover-endpoint` から健全な AZ 自身のエンドポイント ID が取れること、`ReplaceRoute` (VpcEndpointId 指定) が受理されることを確認する。あわせて、現ルートの Gateway Load Balancer エンドポイントの ID が DescribeRouteTables 応答の GatewayId フィールドに入ることを確認する。Terraform Provider ソースでは確認済みである
5. **片 AZ 障害 / 両 AZ 障害の模擬**
   それぞれ ReplaceRoute / ポリシー切り替えが起き、RTO 30 分以内かを計測
6. **自己参照 override の受理**
   健全エッジを自身に向ける override (`edge-sets: [["ap-northeast-1"]]` → `use-edge-location: ap-northeast-1`) がポリシー検証を通るか
7. **冪等スキップ**
   障害継続中、迂回がヘルスチェックの測定に反映されるまでの 2 回目以降の実行が SkipAlreadyApplied を通り、ポリシーバージョンが増えないこと
8. **avoid の維持動作 (sticky avoid) の確認**
   障害リージョンの一部復帰後も avoid が LIVE から復元されて縮まず、新規のポリシー適用が起きないことを確認する。迂回反映前のサイクルは SkipAlreadyApplied、反映後の定常は NoRegionFailover となり、復旧は手動操作のみで始まる
9. **同一セグメント east-west が NFG を通るか**
   公式ドキュメントは「同一セグメント内の service insertion には Isolated mode が必要」と記載する一方、過去の別検証では `isolate-attachments: false` で east-west 検査が動作している。本構成でも Workload VPC 間通信が NFW を通過するかを FLOW ログで確認する (検査されず通過する場合はセグメント設計の見直しが必要)
10. **change set の生成 / 実行の所要時間**
    PENDING_GENERATION → READY_TO_EXECUTE と EXECUTING → EXECUTION_SUCCEEDED の実所要を計測し、poll 間隔 / 上限 (`lib/config.ts` の FAILOVER) を調整する
11. **TLS の INSPECTED アラートが発火するか**
    sid:2000002 は TLS の client_hello を検査通過の INSPECTED アラートとして記録する pass ルールで、sid:3000002 は established な TCP フローを通す pass ルールである。sid:3000002 が同一フローの後続パケット評価を止める場合、sid:2000002 の client_hello アラートが出ない可能性がある。出なければ sid:3000002 にも `alert;` を付けるなどで対処する (通信への影響はなし)
12. **aws-sdk 統合のエラー名接頭辞** (確認済み)
    TestState の Task 実行で `networkmanager:putCoreNetworkPolicy` に存在しない ID を指定すると `NetworkManager.ResourceNotFoundException` が返り、エラー名接頭辞が `NetworkManager.` であることを実測で確定した。ConflictException が本 API のエラー (HTTP 409) であることは [API リファレンス](https://docs.aws.amazon.com/networkmanager/latest/APIReference/API_PutCoreNetworkPolicy.html) に記載がある
13. **send-via per-pair override の受理** (確認済み)
    同一エッジが複数エントリの edge-sets に重複登場する構成と、set 外の use-edge-location (send-via) を、PutCoreNetworkPolicy が受理するか。apne1 ダウン時のポリシーで ap-northeast-1 が send-via 4 エントリすべてに登場し受理・LIVE 化された。set 外 use-edge-location (`[[usw2, apne1]] → use1`) も受理・ルート反映を確認 (evidence/ap-northeast-1ダウン時)
14. **カバー外ペアのデフォルト経路選択によるフォールバック** (確認済み)
    override を生成しないペアがブラックホール化せず、デフォルトの経路選択 (両端の優先上位) で検査されるか。apne1 ダウン時、override に含まれない apne3 エッジの use1 VPC 宛 CIDR が `us-east-1/INSPECTION` で ACTIVE であり、ブラックホール化せずデフォルトの検査先へフォールバックすることを確認した。方式 C を single-set に戻す必要はない (evidence/ap-northeast-1ダウン時)
15. **多重マッチの優先順位** (apne1 ダウン時は確認済み)
    障害リージョンの自己ペア (self-pair) が複数エントリにマッチしたとき、どの値が採用されるか。FIB で確認済み: avoid={use1} → apne1、avoid={apne1} → apne3 (evidence)。候補はいずれも健全なためブラックホールにはならない
16. **両 AZ 障害 NFG への経路がブラックホール化すること**
    avoid リージョンの NFG への経路が、attachment 残置のため迂回せずブラックホール化し、fail-close が成立するか
17. **冪等スキップの空振り更新確認**
    PutCoreNetworkPolicy 側の正規化や並べ替えによって LIVE との deep-equal が不一致になり、内容が同じなのに毎サイクル再適用される空振り更新が発生しないことを確認する (項目 7 の冪等スキップが LIVE の応答形の差異でも成立することの確認)。send-to / send-via 両方で確認する
18. **両端 NFG なしクロスペアの検査先**
    usw2 ↔ apse1 の通信がデフォルトで優先度 1 位 (us-east-1) の NFG で検査されること、use1 の両 AZ 障害時に override で failoverTarget へ移ることを NFW ALERT ログで確認する。「両端なし → #1」の実機根拠はこれまで egress 観測のみである
19. **baseline send-to override の受理と効果**
    自己参照 override を含む baseline が CloudFormation デプロイで受理されること、平常時の各リージョンのヘルスチェックが自リージョンの NFG を通ること (項目 1 の同一 AZ 固定を確認する前提)、apse1 の egress が apne1 の NFG を通ることを FLOW / ALERT ログで確認
20. **時間差多重障害の収束 (sticky avoid)** (確認済み)
    apne1 の両 AZ 障害でフェイルオーバー済みの状態から apne3 も両 AZ 障害にし、次のサイクルで avoid={ap-northeast-1,ap-northeast-3} のポリシー (全エッジ us-east-1 向き) に 1 回で収束すること、ポリシーバージョンが振動して増え続けないことを実行履歴と list-core-network-policy-versions で確認。オーケストレーター経由で自動適用され、FIB で全エッジの全 CIDR が us-east-1/INSPECTION に収束することを確認した (evidence/ap-northeast-1とap-northeast-3ダウン時)
21. **ヘルスチェックの tier フォールバックとサードパーティ不接触**
    平常時の NFW FLOW ログに 1.1.1.1 / 8.8.8.8 宛の接続が現れないこと (tier 1 で完結)、NS lookup と権威 DNS への TCP/53 が VPC 内 Lambda から成立すること、tier 1 の宛先を一時的に遮断すると tier 2 で healthy を維持することを確認
22. **ダッシュボードとメトリクスフィルターの発火**
    次を確認する
    - カスタムメトリクス (ProbeHealthy / ProbeUnhealthy / ProbeLatencyMs / ProbeTier2Contact / Orchestrator 系 8 つ) が実ログで発火すること
    - 平常時に ProbeHealthy が 3 分ごとに全 6 系列で記録されること。これは平常時の正常性を示すシグナルである
    - SFN 実行ログの JSON スキーマ (type / details.name) は公式未記載のため、初回実行のログ 1 件で実フィールド名を確認し、フィルターパターンと Logs Insights クエリ (details.parameters / details.resource) を実態に合わせて調整すること
    - SEARCH 式ウィジェット (NFW / NAT GW / Lambda / Scheduler) の表示と、平常時に ProbeTier2Contact が 0 のままであること

## 手動復旧

復旧は自動化していない。これはフラッピング (障害と復旧の反復で切り替えが振動すること) の防止のためである。元ポリシーは Cloud WAN のバージョン履歴が保持する。
avoid は LIVE ポリシーの send-to override から復元される (sticky avoid) ため、復旧は後述の手動操作だけが起点になる。全リージョンを平常へ戻すときは baseline 相当のバージョンへ、一部だけ戻すときは該当の avoid で作られたバージョンへ戻す。

```bash
# フェイルオーバーで作られたポリシーの description に復旧元バージョンが記録されている
aws networkmanager list-core-network-policy-versions \
  --core-network-id <CORE_NETWORK_ID> \
  --region us-west-2

# 1. 復旧元バージョンを LATEST として復元する (この時点では LIVE にならない)
aws networkmanager restore-core-network-policy-version \
  --core-network-id <CORE_NETWORK_ID> \
  --policy-version-id <VERSION_ID> \
  --region us-west-2

# 2. 復元で採番された新バージョン ID の生成完了 (READY_TO_EXECUTE) を待つ
#    <NEW_VERSION_ID> には手順 1 (restore) の応答の CoreNetworkPolicy.PolicyVersionId を使う
aws networkmanager get-core-network-policy \
  --core-network-id <CORE_NETWORK_ID> \
  --policy-version-id <NEW_VERSION_ID> \
  --region us-west-2 \
  --query CoreNetworkPolicy.ChangeSetState

# 3. change set を実行して LIVE へ反映する
aws networkmanager execute-core-network-change-set \
  --core-network-id <CORE_NETWORK_ID> \
  --policy-version-id <NEW_VERSION_ID> \
  --region us-west-2

# 4. EXECUTION_SUCCEEDED になったことを確認する
aws networkmanager get-core-network-policy \
  --core-network-id <CORE_NETWORK_ID> \
  --policy-version-id <NEW_VERSION_ID> \
  --region us-west-2 \
  --query CoreNetworkPolicy.ChangeSetState
```

restore はバージョンを復元して LATEST にするだけで、**LIVE への反映は決して自動では行われない** ([公式ドキュメント](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policy-version-deploy.html)記載: "Deploying a new policy version never occurs automatically.")。手順 3 の execute を忘れると復旧が完了しないため、必ず手順 4 の確認まで行う。
障害が続いているのに誤って早期復旧した場合は、次のサイクルのヘルスチェックが障害を再検知して avoid を再適用する (自己修復するため安全側)。
復旧完了後は、検証イベントで増えた不要なポリシーバージョンを `delete-core-network-policy-version` で整理する (LIVE 以外はすべて削除可能)。整理の目的は、手動復旧時の復旧元バージョンの選択ミス防止と、バージョン一覧の見通しの維持である。なおバージョン数の上限はデフォルト 10,000 で調整可能であり、OUT_OF_DATE バージョンの保持期間は 90 日である。

片 AZ フェイルオーバー (ReplaceRoute) の復旧は、障害だった AZ が復帰した後に対象ルートテーブルのデフォルトルートを元の AZ の NFW エンドポイント (RT タグ `failover-endpoint` の値) へ戻す。

運用上の注意:

- ポリシー復旧時は、対象リージョンの Inspection VPC の Cloud WAN アタッチメントサブネット RT の 0.0.0.0/0 を必ず確認する。avoid 中のリージョンでも ReplaceRoute は実行され得る。avoid 中はヘルスチェックの通信自体が override で他リージョンへ迂回するため、対象リージョンのローカル AZ の状態を反映しない。そのため確認を怠ると復旧後に片系運転のまま気付けない。ReplaceRoute の発生有無はメトリクス `OrchestratorReplaceRouteDone` で確認できる
- Core Network Policy の send-to override を手動で書き換えない。NFG リージョンのエッジを自身以外へ向けると、LIVE ポリシーから avoid を復元するロジックが「そのリージョンを避けている」と解釈し、意図せず「避け続ける状態 (sticky avoid)」になる。レイテンシ実験などは検証系で行う
- 実行が併走した場合、1 回のフェイルオーバーでポリシーバージョンが 2 つ増えることがある (後発が先発を OUT_OF_DATE にする)。復旧元の選択は Description (`failover avoid=... from vN`) で判別する
- ReplaceRoute で書き換えた RT の 0.0.0.0/0 は CloudFormation 管理リソースのドリフトとして残る。通常のスタック更新では上書きされないが、NFW エンドポイント ID が変わる更新 (NFW の置換など) では CloudFormation がルートを元へ戻すため、AZ が未復旧ならその経路は一時的に不通になる。次サイクルの ReplaceRoute が再適用して自己修復するが、片 AZ 障害の継続中にスタック更新を行う場合はこの一時断を織り込む

## 今後の課題

- アラームへの通知アクション (SNS など) を設定する。アラーム自体は実装済みで、通知アクションのみ未設定である
- fail-close 時に全エッジを自リージョン向きへ戻す「可観測化ポリシー」適用を検討する。fail-close 後の復旧をヘルスチェックで検出できるようにするためである。現在は LIVE ポリシーの参照先によっては、復旧可能になったことをヘルスチェックの成否からは観測できない

## 本番転用時の制約

検証プロジェクトとして簡略化した点と、本番転用時に見直しが必要な点を明示する。

- ポリシー書き換えは「全セグメントが同一の検査設計 (同じ NFG / 同じ優先 NFG マップ) を持つ」前提である。セグメントごとに検査設計を変える場合は、override の生成と適用済み判定をセグメント単位に拡張する必要がある
- ReplaceRoute の退避先は単一の健全な AZ に集約する。複数の健全な AZ へ分散させる設計は将来拡張とする
- ダッシュボードの一部表現 (AZ の a / b 表記など) は 2 AZ 前提である
- NFW のルールが pass-all なのは検証用である。本番で制限的なルールにする場合は、ヘルスチェックの疎通先 (checkip.amazonaws.com / amazonaws.com 権威 DNS への TCP 53 / tier 2 の公開 DNS) の許可を、ルール変更のたびに回帰確認する
- 自動の PutCoreNetworkPolicy は「事前承認済みの自動変更」として変更管理に位置づける。変更記録はポリシーバージョンの Description と SFN 実行ログ (1 年保持) が担う
- エッジ間の Cloud WAN 経路障害と非 NFG リージョン発の経路障害は検知対象外である (監視セクション参照)
- ログ (SFN 実行ログ / NFW ALERT / FLOW / ヘルスチェック Lambda) は 1 年保持 + RETAIN である。cdk destroy してもロググループは残るため、環境の後片付けでは手動削除が必要
- `cdk destroy --all` は依存の逆順で OrchestratorStack (スケジュール込み) を RegionStack より先に削除するため、削除中に定期実行が誤発動することはない。ただし部分的な destroy や削除失敗からの再試行ではスケジュールが残り得るため、destroy 前にスケジュールが無効であることを確認する
- スケジュールリソースに変更が及ぶスタック更新では、State はテンプレートどおり無効へ戻る。変更が及ばない更新では手動で有効化した状態のまま残るため、停止が必要な場合は明示的に無効化する。更新後は疎通確認のうえ有効 / 無効の状態を確認する。有効化忘れは定期実行の停止のアラーム (ExecutionStoppedAlarm) が検知する
- Site-to-Site VPN や Direct Connect を接続する場合、ブラックホール静的ルートと同一プレフィックスの広報経路は静的優先で届かなくなる。対向の広報を実在プレフィックスに細分化するかブラックホールの CIDR を見直すこと

## テスト

```bash
pnpm test          # 純関数 (config / policy) + 各 Stack の fine-grained + snapshot
pnpm type-check    # tsc --noEmit
```

JSONata 変換 (集計 / 網羅生成) の検証は SFN の TestState API で行う。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm type-check` | 型チェック (tsc --noEmit) |
| `pnpm test` | jest によるユニットテスト |
| `pnpm cdk diff` | デプロイ済みスタックとの差分 |
| `pnpm cdk deploy --all` | 全スタックをデプロイ |
| `pnpm cdk synth` | CloudFormation テンプレートを合成 |

## 構成ファイル

| パス | 役割 |
| --- | --- |
| `lib/config.ts` | リージョン / CIDR / ASN / 優先度テーブル / フェイルオーバー定数 / 次点計算の純関数 |
| `lib/core-network-policy.ts` | baseline ポリシー生成 (override はランタイムの JSONata 側) |
| `lib/core-stack.ts` | GlobalNetwork + CoreNetwork |
| `lib/region-stack.ts` | リージョン汎用 Stack |
| `lib/constructs/inspection-vpc.ts` | NFW (2AZ) + NAT + ルーティング + フェイルオーバータグ |
| `lib/constructs/workload-vpc.ts` | 各 AZ のテスト用 EC2 + EIC Endpoint (各リージョン 2 VPC) |
| `lib/constructs/health-check-vpc.ts` | 各 AZ のヘルスチェック Lambda |
| `lib/lambda/health-check/index.py` | TCP 接続チェック (Python 3.14) |
| `lib/orchestrator-stack.ts` | JSONata SFN + EventBridge Scheduler |
