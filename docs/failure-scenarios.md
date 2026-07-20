# 障害シナリオと期待動作

この文書は、Cloud WAN NFG フェイルオーバーの「どの障害で何が自動で起き、通信はどうなり、運用者は何をすべきか」を定義する。

読者と読む範囲は次のとおり。

- 運用者は「前提となる構成」から「状態遷移」までを読む
- 開発者はそれに加えて「override 生成の詳細」と「付録 (検証記録)」を読む
- デプロイ手順と手動復旧のコマンドは [README](../README.md)、send-via override の設計経緯は [send-via-override-research.md](send-via-override-research.md) にある

## 前提となる構成

| リージョン | 略称 | 優先度 | 役割 |
| --- | --- | --- | --- |
| us-east-1 | use1 | 1 | NFG あり (検査 + ヘルスチェック対象) |
| us-west-2 | usw2 | 4 | NFG なし <br>オーケストレーターの所在地 |
| ap-northeast-1 | apne1 | 7 | NFG あり (検査 + ヘルスチェック対象) |
| ap-northeast-3 | apne3 | 9 | NFG あり (検査 + ヘルスチェック対象) |
| ap-southeast-1 | apse1 | 11 | NFG なし <br>両端 NFG なしペアの観測用 (Workload のみ) |

NFG ありリージョンは各 2 AZ (a / b) に Network Firewall のエンドポイントとヘルスチェック Lambda を持つ。
a / b は設定上の AZ 一覧 (config の availabilityZones 配列) の 1 番目と 2 番目を指す論理ラベルであり、ダッシュボードのメトリクス次元も同じラベルを使う。
実 AZ 名とは対応しないことがあり、apne1 の実 AZ は ap-northeast-1a / ap-northeast-1c である。

### 用語

- **NFG (Network Function Group)**：Cloud WAN 上で検査用 VPC を束ねるグループ。トラフィックはいずれかの NFG リージョンの Network Firewall を経由する
- **エッジ**：各リージョンに置かれる Core Network の接続点 (Core Network Edge)
- **優先度**：Cloud WAN が検査リージョンを選ぶ順位表 (default Region priority list) の番号。小さいほど優先され、地理的な近さは考慮されない
- **片 AZ 障害**：リージョン内 2 本のヘルスチェックのうち 1 本が失敗した状態 (一般には一部の AZ のみ異常の状態)
- **両 AZ 障害**：2 本とも失敗した状態。そのリージョンの検査機能は全面停止とみなす
- **障害判定リージョン**：そのサイクルのヘルスチェックが両 AZ 障害と判定したリージョンの集合。ポリシー操作の起動判定に使う
- **avoidRegions**：障害判定リージョンに、LIVE ポリシーで既に検査先から外しているリージョンを加えたもの。目標ポリシーの計算に使う。27 通り表の avoidRegions 列はこれを指す (障害が単調に進行する範囲。復旧を挟む場合は「状態遷移」を参照)
- **failoverTarget**：avoidRegions を除いた NFG リージョンのうち優先順位が最上位 (番号が最小) のもの。迂回先になる
- **ReplaceRoute**：片 AZ 障害時に自動で行う切り替え。障害 AZ のルートテーブル (以下 RT) を健全な AZ の Network Firewall エンドポイントへ向け直す
- **override (with-edge-overrides)**：Cloud WAN ポリシーに書き込む検査先の上書き。send-to は平常時から常設 (各エッジ → 優先 NFG) し、障害時はフェイルオーバーが健全な検査先へ書き換える。send-via は障害時のみ生成する
- **baseline ポリシー**：平常時に適用しておく初期ポリシー
- **LIVE ポリシー**：現在有効なポリシーバージョン
- **change set**：PutCoreNetworkPolicy で作成した新ポリシーバージョンを LIVE に反映するための変更セット。生成と実行の 2 段階がある。CloudFormation の change set とは別物である
- **フォールバックグループ (tier)**：ヘルスチェックが TCP 接続を試みるエンドポイントのグループ。グループ内は並列に試行し、全エンドポイントが失敗したときだけ次のグループを試す。tier 1 は AWS 管理のエンドポイント、tier 2 はサードパーティの最終フォールバック
- **目標ポリシー**：avoidRegions に含まれるリージョンを検査先から外すように各エッジの override を決めたポリシー。send-to は per-edge、send-via は per-pair の生成規則で一意に定まる (「override 生成の詳細」を参照)
- **デフォルトの検査先**：override を書かないときに Cloud WAN が選ぶ検査リージョン。ペアの両端から優先度で決まる
- **fail-close**：全 NFG リージョンが両 AZ 障害のとき、あえて何もしない判断。検査できない通信は通さない方針を指す
- **レベルトリガー**：3 分ごとに毎回、現在の観測と LIVE ポリシーの内容だけから目標ポリシーを再計算し収束させる方式。実行履歴には依存しない

## 障害の種類とフェイルオーバー動作の全体像

| 障害 | フェイルオーバー動作 | 切り替え完了までの通信 | 完了後の通信 | 復旧 |
| --- | --- | --- | --- | --- |
| 片 AZ 障害 | ReplaceRoute | 障害 AZ 経由の通信は失敗し得る | 健全な AZ 経由で検査を継続 | 手動 |
| 1〜2 リージョンの両 AZ 障害 | ポリシーへ override 適用 | 障害リージョン向きの経路はブラックホール | 健全リージョンで検査を継続 | 手動 |
| 全 NFG リージョンの両 AZ 障害 | なし (fail-close) | - | 検査対象の通信は全断 | 手動 |

フェイルオーバーが行うのは、障害状態からの退避だけである。
復旧 (元のリージョン構成に戻す操作) はフラッピング防止のためすべて手動であり、手順は README の「手動復旧」にある。
fail-close や実行失敗などの重大事象は CloudWatch アラーム (通知アクション未設定) とダッシュボードで検知する。
SNS などへの発報は未実装のため、アラーム状態の確認は運用者が行う (README の「監視」)。
検証環境のためアラーム確認は手動であり、確認頻度の要件は定義していない。
本番転用時は SNS などへの発報の実装を前提とする。

## 判定の仕組み

- EventBridge Scheduler が 3 分ごとに Step Functions (以下 SFN) を起動する。スケジュールは無効状態でデプロイされ、初期デプロイの動作確認後に手動で有効化する (README の「デプロイ」)
- SFN は全 NFG リージョン x 2 AZ の計 6 本のヘルスチェック Lambda を並列実行する。判定は次の 2 点で行う。3 点目は判定の観点ではなく疎通先の構成である
  - 経路の判定: 各 Lambda は外部エンドポイントへの TCP 接続で自 AZ の検査経路の正常 / 異常を判定する
  - 障害の帰属: 平常時のヘルスチェックは baseline ポリシーの send-to override により自リージョンの NFG を通る。これにより障害の帰属が成立する
  - 疎通先の tier 構成: 疎通先は AWS 管理のエンドポイントを優先する段階構成で、前の段階が全面停止したときだけサードパーティの最終フォールバックへ進む。AWS 管理のエンドポイントは、amazonaws.com の NS レコードを実行時に解決した権威 DNS サーバー群と checkip.amazonaws.com である。サードパーティの最終フォールバック (tier 2) の宛先は 1.1.1.1 / 8.8.8.8 で、詳細は README の「ヘルスチェック仕様」に記載がある
- AZ の正常 / 異常の組み合わせでリージョン状態を決める。全 AZ が異常ならリージョン障害となり avoid の対象になる。一部の AZ だけ異常なら片 AZ 障害となり ReplaceRoute の対象になる。ReplaceRoute では、異常だった全 AZ の RT を、設定上の AZ 一覧 (config の availabilityZones 配列) の並びで最初の健全な AZ へ切り替える。判定は AZ 数に依存しない。2 AZ 構成では「1 本失敗 = 片 AZ、2 本失敗 = 両 AZ」と同値になる
- 1 回目の測定で異常が出たときだけ、90 秒後に同じ 6 本を再測定し、2 回とも異常の AZ だけを障害と確定する (確認再測定)。ReplaceRoute / avoid は復旧が手動の不可逆アクションのため、単一サイクルの瞬断の誤検知では発動させない。1 回目正常の AZ は 2 回目の結果にかかわらずそのサイクルでは健全扱いとし、悪化していれば次サイクルの 1 回目として改めて検知される
- ポリシー操作に使う avoidRegions は、障害判定リージョンと「LIVE ポリシーが既に検査先から外しているリージョン」(send-to override の参照先から復元する) の和集合である。フェイルオーバー適用後は迂回済みエッジのヘルスチェックが迂回先を測定するため、ヘルスチェックだけでは障害の継続を観測できない。和集合により、一度外したリージョンは手動復旧まで外れたままになる
- 片 AZ 障害のリージョンは ReplaceRoute の対象になるが、検査先としては健全扱いのままにする。健全な AZ で処理を継続できるからである
- ポリシー操作は、障害判定リージョンが 1 つ以上あるサイクルでのみ起動する。起動後は avoidRegions から目標ポリシーを計算し、LIVE と一致していればスキップする (冪等)

## 両 AZ 障害時の時系列の例

apne1 が両 AZ 障害になった場合の流れを示す。RTO 目標は 30 分である。

| 時点 | 起きること | 通信への影響 |
| --- | --- | --- |
| T+0 | apne1 の両 AZ で検査経路が停止 | apne1 を検査先とする通信がブラックホール化 |
| 〜T+3 分 | 次の定期実行が両 AZ 障害を検知 | 同上 (継続) |
| 〜T+5 分 | 90 秒後の確認再測定で両 AZ 障害を確定し、PutCoreNetworkPolicy を実行 | 同上 (継続) |
| 〜T+10 分 | change set の生成完了を待機して実行開始 <br>待機は 10 秒間隔で最大 5 分 | 同上 (継続) |
| 〜T+25 分 | change set の実行完了を待機 <br>待機は 30 秒間隔で最大 15 分 | 完了時点で健全リージョン (use1 / apne3) の検査に切り替わり回復 |

ブラックホールが解消するのはポリシー反映が完了した時点である。
Cloud WAN は障害リージョンから自動でフォールバックしないため (実機確認済み)、この間の通信断は避けられない。
実際の所要時間は実機で計測し、待機間隔と上限を調整する (README の実機検証 10)。

片 AZ 障害の対応はこれより速い。
確認再測定 (90 秒) の後は対象 AZ ごとに EC2 API を 2 回呼ぶだけなので、次の定期実行から 2 分前後で健全な AZ へ切り替わる。

## リージョン状態 27 通りの期待動作

3 つの NFG リージョンの状態の全組み合わせと、それぞれのフェイルオーバー動作を示す。
どのリージョン間の通信がどの NFG で検査されるかは avoidRegions 列の値で決まる。例外は障害リージョン自身の内部通信の 2 セルで、検査先が未確定である (後述のマトリクスの注 1)。
avoidRegions はヘルスチェックの検出と LIVE から復元した集合の和で決まるため、この表は障害の発生順序には依存しない (時間差の多重障害でも同じ行に収束する)。ただし適用できるのは baseline から障害が単調に進行する系列に限る。
復旧を挟んだ系列では、一度検査先から外したリージョンが LIVE から復元されるため、avoidRegions は表の値に復元分を加えた集合になる (「状態遷移」の部分復旧の行を参照)。
ペアごとの検査先は後述の「通信ペアごとの検査リージョン」のマトリクスを avoidRegions で引く。

状態の表記: **H** = 正常 / **S** = 片 AZ 障害 / **D** = 両 AZ 障害

| # | use1 | apne1 | apne3 | ReplaceRoute 実行 | avoidRegions | failoverTarget | ポリシー操作 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | H | H | H | なし | なし | - | なし |
| 2 | H | H | S | apne3 | なし | - | なし |
| 3 | H | H | D | なし | apne3 | use1 | 適用 |
| 4 | H | S | H | apne1 | なし | - | なし |
| 5 | H | S | S | apne1 / apne3 | なし | - | なし |
| 6 | H | S | D | apne1 | apne3 | use1 | 適用 |
| 7 | H | D | H | なし | apne1 | use1 | 適用 |
| 8 | H | D | S | apne3 | apne1 | use1 | 適用 |
| 9 | H | D | D | なし | apne1 / apne3 | use1 | 適用 |
| 10 | S | H | H | use1 | なし | - | なし |
| 11 | S | H | S | use1 / apne3 | なし | - | なし |
| 12 | S | H | D | use1 | apne3 | use1 | 適用 |
| 13 | S | S | H | use1 / apne1 | なし | - | なし |
| 14 | S | S | S | 全 3 リージョン | なし | - | なし |
| 15 | S | S | D | use1 / apne1 | apne3 | use1 | 適用 |
| 16 | S | D | H | use1 | apne1 | use1 | 適用 |
| 17 | S | D | S | use1 / apne3 | apne1 | use1 | 適用 |
| 18 | S | D | D | use1 | apne1 / apne3 | use1 | 適用 |
| 19 | D | H | H | なし | use1 | apne1 | 適用 |
| 20 | D | H | S | apne3 | use1 | apne1 | 適用 |
| 21 | D | H | D | なし | use1 / apne3 | apne1 | 適用 |
| 22 | D | S | H | apne1 | use1 | apne1 | 適用 |
| 23 | D | S | S | apne1 / apne3 | use1 | apne1 | 適用 |
| 24 | D | S | D | apne1 | use1 / apne3 | apne1 | 適用 |
| 25 | D | D | H | なし | use1 / apne1 | apne3 | 適用 |
| 26 | D | D | S | apne3 | use1 / apne1 | apne3 | 適用 |
| 27 | D | D | D | なし | 全 3 リージョン | null | fail-close (ログのみ) |

補足を 3 点挙げる。

- 「適用」は初回のみ実行される。適用直後、迂回がまだヘルスチェックの測定に反映されない間のサイクルは、障害判定リージョンが残るため起動するが、LIVE との一致を検出してスキップする (`skipped: already-applied`)。迂回が有効になった後の定常状態は障害判定リージョンが空になり、起動せず NoRegionFailover で終わる
- 片 AZ 障害の AZ が a か b かで動作は変わらない。ルートテーブルはタグで特定するため両方向とも同じロジックが働く。付け替え後は障害 AZ のヘルスチェックも健全 AZ のエンドポイント経由で成功するため、片 AZ 障害の検出は通常解消する。検出が継続する間に ReplaceRoute が再実行されても、同じ値への置き換えのため冪等である
- fail-close (#27) はポリシーを変更しない。直前の override が指す NFG も両 AZ 障害のため、トラフィックはブラックホール化し、結果として「検査できない通信は通さない」状態になる

## 障害時の見え方と運用対応

重大事象の一次検知は、全体像の節で述べたとおり CloudWatch アラームとダッシュボードで行う。
個別実行の詳細は SFN の実行結果から読み取る。
実行ログは us-west-2 の CloudWatch Logs のロググループ OrchestratorLogs にレベル ALL で残る。

### 実行結果の読み方

| 実行の終わり方 | 意味 | 運用対応 |
| --- | --- | --- |
| 成功 <br>出力に NoRegionFailover | 両 AZ 障害を検出せず <br>正常か、迂回適用後の定常状態か、片 AZ 対応のみ | 不要 |
| 成功 <br>出力に FailoverDone | ポリシー切り替えが完了 | 影響範囲の確認と復旧計画 |
| 成功 <br>出力に `skipped: already-applied` | 障害継続中で、切り替えは適用済み | 復旧作業の実施 |
| 成功 <br>出力に `stillExecuting: true` | 切り替えはサーバー側で実行中 | 次サイクル以降の完了を待つ |
| 成功 <br>出力に `skipped: core-network-not-available` / `conflict` / `superseded-by-newer-version` | 他の変更と競合し今回は見送り | 不要 (次サイクルが再試行) |
| 成功 <br>出力に `replaced: false` | 片 AZ 障害の ReplaceRoute が失敗 | 継続するならタグと API エラーを調査 |
| 成功 <br>ReplaceRouteDone を通過 (メトリクス OrchestratorReplaceRouteDone) | 片 AZ 障害の ReplaceRoute を実行した | RT の付け替えを把握し、復旧時にデフォルトルート (0.0.0.0/0) を戻す |
| 成功 <br>ConfirmationCanceled を通過 (メトリクス OrchestratorConfirmationCanceled) | 1 回目の検知が確認再測定で取り消された (瞬断) | 単発なら不要 <br>短時間に繰り返す場合は断続障害を疑い Network Firewall の FLOW ログを調査 |
| 成功 (実行は継続) <br>HealthCheckFail / HealthCheckConfirmFail を通過 (メトリクス OrchestratorProbeInvokeError) | ヘルスチェック Lambda の呼び出し自体が失敗 | 検査経路ではなくヘルスチェック基盤側の異常を疑う <br>ProbeUnhealthy と同時発生していないか確認 |
| 成功 <br>メトリクス ProbeTier2Contact が 0 以外 | AWS 管理のエンドポイント (tier 1) が全面停止しサードパーティへ接続した | tier 1 側の異常 (経路または AWS 側) を調査 |
| 成功 <br>出力に `failClose: true` | **全 NFG 断 <br>検査対象の通信は全断** | 即時対応 (最重大) |
| 失敗 <br>エラー ChangeSetNotGenerated | change set が 5 分以内に生成されない | 実行履歴の genState を確認 |
| 失敗 <br>エラー ChangeSetNotApplied | change set が実行中に失敗 | 実行履歴の changeSetState を確認 |
| 失敗 <br>その他 (States.Timeout 等) | 想定外の失敗 | 実行履歴から調査 |

注: ReplaceRoute は avoid 中のリージョンでも実行され得る。

失敗で終わってもフェイルオーバーの機会が失われるわけではない。
レベルトリガーのため、3 分後の次サイクルが同じ判定をやり直す。

### 状態確認に使う情報

- 一次情報の集約は us-west-2 のダッシュボード `nfg-failover-operations` (README の「監視」)。fail-close / tier 2 (サードパーティ宛先の 1.1.1.1 / 8.8.8.8) への接続 / SFN 失敗が 0 以外なら、この表の該当行で対応を引く
- ポリシーの適用履歴は `aws networkmanager list-core-network-policy-versions` で確認できる。フェイルオーバーが作ったバージョンは Description が `failover avoid=<リージョン> from v<復旧元番号>` になっており、手動復旧時の戻り先がここからわかる
- どのリージョンで検査されたかは、Network Firewall の ALERT ログに出る `INSPECTED at <リージョン>` で実測できる
- AZ 単位の経路は Network Firewall の FLOW ログで確認する
- 障害検知中は確認再測定によりヘルスチェックが 1 サイクルに 2 回実行されるため、ヘルスチェック系カスタムメトリクス (ProbeUnhealthy 等) は同一サイクルで 2 カウントされ得る (平常時は 1)

## 通信ペアごとの検査リージョン

east-west 通信 (VPC 間) の検査リージョンは「ペアの両端 2 リージョン」から選ばれる。
両端に NFG があれば優先度上位の端、片端だけならその端、両端になければ優先度 1 位のリージョンが使われる。
両端にない場合の挙動は egress の観測からの外挿であり、README の実機検証 18 で確認予定である。
この選択に地理的な近さは影響しない。

同一リージョン内の VPC 間通信 (各リージョンの Workload VPC 1 ↔ 2) は両端が同じリージョンなので、そのリージョンに NFG があればローカルで検査される。
これは公式記載からの推論であり、実機では未確認である (README の実機検証 9)。

次表が全通信ペアの検査先マトリクスである。
列は avoidRegions (両 AZ 障害のリージョン集合) で、27 通り表の avoidRegions 列の値から該当列を引く。
片 AZ 障害は検査先を変えない (健全な AZ で同じリージョンが使われる) ため、この表には現れない。

| 通信ペア | avoid なし | use1 | apne1 | apne3 | use1 / apne1 | use1 / apne3 | apne1 / apne3 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| use1 内 VPC 間 (注 2) | use1 | 注 1 | use1 | use1 | apne3 | apne1 | use1 |
| usw2 内 VPC 間 (注 2 / 注 3) | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| apne1 内 VPC 間 (注 2) | apne1 | apne1 | 注 1 | apne1 | apne3 | apne1 | use1 |
| apne3 内 VPC 間 (注 2) | apne3 | apne3 | apne3 | use1 | apne3 | apne1 | use1 |
| use1 ↔ usw2 | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| use1 ↔ apne1 | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| use1 ↔ apne3 | use1 | apne3 | use1 | use1 | apne3 | apne1 | use1 |
| usw2 ↔ apne1 | apne1 | apne1 | use1 | apne1 | apne3 | apne1 | use1 |
| usw2 ↔ apne3 | apne3 | apne3 | apne3 | use1 | apne3 | apne1 | use1 |
| apne1 ↔ apne3 | apne1 | apne1 | apne3 | apne1 | apne3 | apne1 | use1 |
| apse1 内 VPC 間 (注 2 / 注 3) | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| use1 ↔ apse1 | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| usw2 ↔ apse1 (注 3) | use1 | apne1 | use1 | use1 | apne3 | apne1 | use1 |
| apne1 ↔ apse1 | apne1 | apne1 | use1 | apne1 | apne3 | apne1 | use1 |
| apne3 ↔ apse1 | apne3 | apne3 | apne3 | use1 | apne3 | apne1 | use1 |

注 1: 両 AZ 障害になったリージョン自身の内部通信で、検査先は健全リージョンのいずれかになる。どちらになるかは実機で確認する (未確認)。候補はいずれも健全なため、多重マッチ時にいずれかのエントリが選ばれる限りブラックホールにはならない (選択規則の存在自体は実機検証 15 で確認する)。
注 2: 同一リージョン内の VPC 間通信が NFG で検査されること自体が実機では未確認である (README の実機検証 9)。
注 3: 両端に NFG がないため優先度 1 位を使うという egress 観測からの外挿に基づく (README の実機検証 18 で確認予定)。
avoidRegions が全 3 リージョンの場合はポリシーを変更せず、検査対象の通信は全断になる (fail-close)。

読み方の例を 2 つ挙げる。

- 27 通り表の #3 (apne3 のみ両 AZ 障害) では avoidRegions = apne3 なので「apne3」列を引く。apne1 ↔ apne3 の通信は apne1 で検査される。デフォルトの検査先 (両端の優先上位 = apne1) が健全なので、override は生成されず迂回も起きない
- #19 (use1 のみ両 AZ 障害) では「use1」列を引く。apne3 内の VPC 間通信は apne3 のローカル検査を維持し、デフォルトの検査先が use1 だった通信だけが apne1 や apne3 へ迂回する

健全なリージョンのローカル検査が障害時も維持され、迂回するのはデフォルトの検査先が障害リージョンだった通信だけになる。
これが per-pair override 設計の狙いである。

## フェイルオーバーの仕組み自体に異常が起きた場合の挙動

| 異常 | 挙動 | 実装上の根拠 |
| --- | --- | --- |
| ヘルスチェックの呼び出し失敗 / 30 秒タイムアウト | 該当 AZ を障害扱い | タスクの Catch で unhealthy に正規化 |
| Lambda の実行時例外 / 関数タイムアウト | 該当 AZ を障害扱い | FunctionError を出力式で明示的に unhealthy として扱う |
| Lambda 応答の形式不正 / healthy キー欠落 | 該当 AZ を障害扱い | 判定式が boolean 以外を false として扱う (fail-close 方向で安全側) |
| Core Network が更新中 (UPDATING) | 今回のポリシー操作を見送り | 次サイクルが再試行 |
| PutCoreNetworkPolicy の競合 | 今回のポリシー操作を見送り | ConflictException のみ捕捉し、他の失敗は実行失敗として可視化 |
| change set の生成が 5 分超 / 生成失敗 | 実行失敗として可視化 | 次サイクルが再試行 |
| change set の実行が 15 分超 | 正常終了して次サイクルへ引き継ぎ | 実行はサーバー側で継続するため失敗扱いにしない |
| ReplaceRoute の失敗 | 失敗を記録して他の処理を継続 | 片 AZ 対応の失敗が両 AZ 対応を止めないよう分離 |
| 実行の重複 (前回実行が 3 分超え) | 実害なし | UPDATING チェックと競合捕捉と ReplaceRoute の冪等性で吸収 |
| us-west-2 (オーケストレーター) 自体の障害 | フェイルオーバー不能 <br>適用済みの検査経路 (データプレーン) は継続し、失われるのは新たな障害への自動対応のみ <br>検証環境の設計判断として許容する | Network Manager のコントロールプレーンも us-west-2 のため対策不能 |

設定ミス (環境変数の欠落など) によるヘルスチェックの異常終了も「全 AZ 障害」と同じ扱いになり、fail-close 方向として扱われる。
検査なしで通信を通す方向には障害を起こさない。

## 状態遷移

| 遷移 | 期待動作 |
| --- | --- |
| 障害継続 (状態不変) | 迂回反映までの過渡期は `skipped: already-applied` でスキップし、反映後の定常は障害判定リージョンが空になり起動せず NoRegionFailover で終わる <br>いずれもポリシーバージョンは増えず、迂回は残置される |
| 障害進行 <br>例: use1 両 AZ 断の後に apne3 も両 AZ 断 | ヘルスチェックが検出した障害と LIVE が既に避けている集合の和で override を作り直す <br>どの順で障害が起きても同じ結果に収束する (経路非依存) |
| 生成方式の変更を含むデプロイ更新 | send-via の形式差を検出して再適用する <br>再適用が実行されるのは障害判定リージョンが 1 つ以上あるサイクルに限る |
| 部分復旧 (例: 2 リージョン障害から 1 リージョン復帰) | 自動では戻さない <br>一度避けたリージョンは LIVE から復元されるため、復帰後も手動復旧までは避けたまま (完全復旧と同じ扱い) |
| 完全復旧 (障害判定リージョンが空に戻る) <br>avoidRegions は LIVE から復元されるため手動復旧まで空にならない | 何もしない <br>override は残置され、手動復旧するまで迂回が続く |
| fail-close 後に一部復旧 | fail-close からの自動離脱 (健全化したリージョンへの退避の再適用) が起きるのは、復旧したリージョンへ向いているエッジが LIVE に残っている場合だけ <br>すべてのエッジが障害中の迂回先を向いた状態で fail-close に入った場合は自動では抜けられず、手動復旧が必要 |

完全復旧で自動的に元へ戻さないのは意図的な設計である。
障害が不安定に再発する状況でポリシーの適用と巻き戻しを繰り返さないためであり、最終的な巻き戻しは人が状況を確認してから行う。
部分復旧も同じ扱いであり、復旧の起点は常に手動操作 (README の「手動復旧」) である。

---

## override 生成の詳細 (開発者向け)

以降は override の生成規則と検証記録であり、運用判断には不要である。

### send-to (egress) の per-edge override

send-to は per-edge である。各エッジの優先 NFG が健全ならそれを、障害中なら failoverTarget を向く。優先 NFG は、NFG ありのエッジでは自身、NFG なしのエッジでは設計時に静的に定めた最近傍リージョンである (usw2 → use1 / apse1 → apne1。config.ts の `preferredNfg` で定義)。平常時も baseline ポリシーが同じマップを常設する。

| avoidRegions | target | use1 エッジ | usw2 エッジ | apne1 エッジ | apne3 エッジ | apse1 エッジ |
| --- | --- | --- | --- | --- | --- | --- |
| なし | - | use1 (自身) | use1 | apne1 (自身) | apne3 (自身) | apne1 |
| use1 | apne1 | apne1 | apne1 | apne1 (自身) | apne3 (自身) | apne1 |
| apne1 | use1 | use1 (自身) | use1 | use1 | apne3 (自身) | use1 |
| apne3 | use1 | use1 (自身) | use1 | apne1 (自身) | use1 | apne1 |
| use1 / apne1 | apne3 | apne3 | apne3 | apne3 | apne3 (自身) | apne3 |
| use1 / apne3 | apne1 | apne1 | apne1 | apne1 (自身) | apne1 | apne1 |
| apne1 / apne3 | use1 | use1 (自身) | use1 | use1 | use1 | use1 |
| 全 3 | null | 変更なし (fail-close) | 同左 | 同左 | 同左 | 同左 |

### send-via (east-west) の per-pair override

send-via は最小 override 方式をとる。
デフォルトの検査先が障害中の NFG に向かうペアだけを override し、値は「健全な NFG 端の優先上位」か「failoverTarget」にする。
override されないペアはデフォルトの検査先に従うため、健全リージョンのローカル検査が維持される。

| avoidRegions | 生成エントリ (edge-sets → use-edge-location) |
| --- | --- |
| なし | 生成なし (baseline) |
| use1 | 8 エントリ: <br>- [[use1,usw2]]→apne1 <br>- [[use1,apne1]]→apne1 <br>- [[use1,apne3]]→apne3 <br>- [[use1,apse1]]→apne1 <br>- [[usw2,apse1]]→apne1 <br>- [[use1]]→apne1 <br>- [[usw2]]→apne1 <br>- [[apse1]]→apne1 |
| apne1 | 4 エントリ: <br>- [[usw2,apne1]]→use1 <br>- [[apne1,apne3]]→apne3 <br>- [[apne1,apse1]]→use1 <br>- [[apne1]]→use1 |
| apne3 | 3 エントリ: <br>- [[usw2,apne3]]→use1 <br>- [[apne3,apse1]]→use1 <br>- [[apne3]]→use1 |
| use1 / apne1 | 12 エントリ (すべて apne3) |
| use1 / apne3 | 11 エントリ (すべて apne1) |
| apne1 / apne3 | 7 エントリ (すべて use1) |
| 全 3 | 生成なし (fail-close により PutPolicy に到達しない) |

障害中のリージョン自身の自己ペア (self-pair) は複数エントリにマッチするが、マッチ先の候補値が一致せず検査先が未確定になるのは avoid が use1 または apne1 単独の 2 ケースに限られる。
他のケースは全マッチ先が同一値のため確定する。
未確定の 2 ケースの優先順位は実機で確認する (未確認)。
候補値はいずれも健全なため、多重マッチ時にいずれかのエントリが選ばれる限りブラックホールにはならない (選択規則の存在自体は実機検証 15 で確認する)。

---

## 付録: 検証記録 (開発者向け)

デプロイ不要の SFN TestState API で、合成テンプレート (cdk synth の出力) から抽出した JSONata 式をそのまま実行して確認した。

### 発見して修正したバグ

いずれも修正前はフェイルオーバー全体が機能しないか、ポリシーが不正になる致命的なバグだった。

1. **Aggregate の述語スコープバグ**：`$results[region = $ ...]` の `$` はフィルタ対象要素を指すため down / up が常に空になり、どんな障害を入力しても avoidRegions / replaceTargets が空になる。T1 で実証し、外側の値を `$r` に束縛して修正
2. **edge-sets のフラット化バグ**：配列コンストラクタ内の配列変数参照 `[$all]` はシーケンス展開で `["r1","r2"]` に潰れ、edge-sets のスキーマ (配列の配列) に違反する。T12 で実証し、リテラル直接埋め込み `[["r1","r2",...]]` に修正
3. **Payload の $parse バグ**：cross-region proxy Lambda (CDK が生成するリージョン間 API 呼び出しの中継 Lambda) は Payload が有効な JSON ならパース済みオブジェクトで返す (aws-cdk-lib のハンドラーソースで確認)。`$parse` はオブジェクトに対し実行時エラーになり、Catch が捕捉して全 AZ ダウン扱い、毎サイクル fail-close になる。オブジェクト / 文字列両対応と FunctionError の明示 unhealthy 化に修正
4. **PutPolicy 直後の ExecuteChangeSet レース**：change set の生成は非同期のため Put 直後の Execute は失敗し、両 AZ 障害時のポリシー書き換えが一度も適用されない。Execute の前に生成完了待ちループを追加して修正
5. **Parallel ブランチ間の連鎖失敗**：ReplaceRoute 系タスクに Catch がなく、片 AZ 障害処理の失敗が Parallel 全体を停止して両 AZ 障害対応をブロックする。Catch を追加し、失敗を記録して完走させるよう修正
6. **実行ポーリング上限到達の偽 Fail**：change set の実行はサーバー側で継続するため、上限到達を Fail にすると失敗報告が誤りになる。正常終了して次サイクルへ引き継ぐよう修正
7. **Catch 遷移先での $states.errorOutput 参照**：バグ 5 の修正で混入。`$states.errorOutput` は Catch フィールド自身でのみ有効なため、遷移先での参照はバリデーション失敗または実行時エラーになる。静的出力に修正
8. **baseline のヘルスチェック帰属欠陥** (2026-07-15 検出)：override なしの egress は全エッジが優先度 #1 へ向かうため、平常時は全リージョンのヘルスチェックが us-east-1 の NFG を通り、us-east-1 の単独障害が「全リージョン両 AZ 障害 → fail-close」に誤判定される (期待は #19 のフェイルオーバー)。baseline ポリシーに send-to の per-edge override (各エッジ → 優先 NFG) を常設して修正。副次効果として apse1 の egress が最近傍の apne1 になりレイテンシも改善
9. **時間差多重障害での avoid 集合の経路依存 (振動)** (2026-07-15 検出)：レビュー指摘を契機に発見した。フェイルオーバー適用後は迂回済みエッジのヘルスチェックが迂回先を測定するため、先に避けたリージョンが avoid から抜け落ちる。2 つ目の両 AZ 障害が現在の迂回先以外で起きると (例: #8 → #9)、avoid が {apne3} と {apne1} を交互に検出し、#3 相当と #7 相当のポリシーを無限に振動適用して正しい #9 に到達しない。振動の各遷移で障害中の NFG へエッジを戻すためブラックホールが交互に発生する。修正として、LIVE ポリシーの send-to override から「既に避けている集合」を復元し、ヘルスチェックが検出した down と和集合を取る方式を採用した。この方式を sticky avoid (一度避けたリージョンを手動復旧まで避け続ける方式) と呼ぶ。副次的な挙動変更として、部分復旧の自動再適用は行わず手動復旧に一本化した。修正前もヘルスチェックが迂回先を測定してしまうことにより、部分復旧の自動再適用は実際には機能していなかった

補足: `ChangeSetState` に `EXECUTION_FAILED` という値は存在しない (botocore の API モデルで確認)。ポーリングの分岐に考慮漏れはない。

### TestState で全パス確認したテスト

バグ実証テスト (失敗が期待値) のうち T1 / T12 は本文のバグ記述側にのみ記載する。T14 はバグ 3 の実証として表に収載している。

2026-07-09 実施分:

| テスト | 対象シナリオ | 結果 |
| --- | --- | --- |
| T2 | #19 (use1 両 AZ 断) | avoid=[use1] / target=apne1 ✓ |
| T3 | #4 相当 (apne1 片 AZ a 断) | replace=[{apne1, a→b}] / avoid=[] ✓ |
| T4 | #16 相当 (use1 片 AZ b + apne1 両 AZ) | avoid=[apne1] / replace=[{use1, b→a}] / target=use1 ✓ |
| T5 | #21 (use1 + apne3 両 AZ 断) | avoid=[use1, apne3] / target=apne1 ✓ |
| T6 | #27 (全 NFG 断) | failClose=true / target=null ✓ |
| T7 | #1 (全健全) | avoid=[] / replace=[] ✓ |
| T8 | per-edge send-to override 生成 | 4 エントリの期待マッピング ✓ |
| T9 | 冪等: LIVE = 目標ポリシー | true ✓ |
| T10 | 障害進行 (#19 → #21 の LIVE 不一致) | false ✓ |
| T11 | LIVE = baseline | false ✓ |
| T13 | ReplaceRoute の RT / endpoint 抽出 | failedRtId / survivorEndpoint とも期待値 ✓ |
| C1〜C3 | 合成テンプレートから抽出した式そのまま | Aggregate / PutPolicy 生成 / AlreadyApplied すべて ✓ |
| T14 | 旧 healthy 式 (オブジェクト Payload に $parse) | 実行時エラーで失敗 (バグ 3 の実証) |
| T15 | 新 healthy 式 6 ケース | すべて期待通りの boolean ✓ |
| T16 | NeedReplace 条件 / PutPolicy Description 連結 | false / 期待文字列 ✓ |

2026-07-12 実施分 (send-via per-pair)。
**この表は ap-southeast-1 追加前の 4 リージョン構成 (10 ペア) での記録**であり、エントリ数は当時の値である。5 リージョン化後の再検証は次の 2026-07-15 実施分を参照。

| テスト | 対象 | 結果 |
| --- | --- | --- |
| V1 | avoid=[use1] の ovrVia | 5 エントリ (use1-apne3 ペアは apne3 保持) ✓ |
| V2 | avoid=[apne1] の ovrVia | 3 エントリ <br>apne3 の自己ペアのエントリなし = apne3 内通信はローカル維持 ✓ |
| V3 | avoid=[apne3] の ovrVia | 2 エントリ ✓ |
| V4 | avoid=[use1,apne1] の ovrVia | 8 エントリすべて apne3 ✓ |
| V5 | avoid=[use1,apne3] の ovrVia | 7 エントリすべて apne1 ✓ |
| V6 | avoid=[apne1,apne3] の ovrVia | 5 エントリすべて use1 ✓ |
| V7 | avoid=[] の ovrVia | [] (baseline のため生成なし) ✓ |
| V8 | 冪等: LIVE = per-pair 適用済み | true ✓ |
| V9 | 冪等: LIVE = 旧 single-set | false (send-via 不一致で再適用) ✓ |
| V10 | 冪等: LIVE = baseline | false ✓ |
| V11 | 空 desiredVia + liveVia=[] | true (無駄な再適用をしない) ✓ |
| V12 | 空 desiredVia + liveVia=非空 | false (残置 override の除去で再適用) ✓ |

全出力で edge-sets のネスト `[["a","b"]]` / `[["x"]]` が保持されることも確認した。

2026-07-15 実施分。
ap-southeast-1 追加後の 5 リージョン構成 (15 ペア) で、合成テンプレートから抽出した式で再検証した。

| テスト | 対象 | 結果 |
| --- | --- | --- |
| W1 | avoid=[use1] の ovrVia | 8 エントリが本文の表と内容 / 順序とも完全一致 ([[usw2,apse1]]→apne1 / [[apse1]]→apne1 を含む) ✓ |
| W2 | avoid=[apne1] の ovrVia | 4 エントリ ([[apne1,apse1]]→use1 を含む) ✓ |
| W3 | avoid=[] の ovrVia | [] (baseline のため生成なし) ✓ |
| W4 | avoid=[use1] の ovrTo | 5 エントリ ([[ap-southeast-1]]→target を含む) ✓ |

マトリクス全 105 セルの機械照合 (生成規則からの導出と本文の表の突き合わせ) も不一致 0 件 / ブラックホール 0 件で完了している。

2026-07-15 実施分 (sticky avoid = バグ 9 修正)。
合成テンプレートから抽出した MergeLiveAvoid の式で、LIVE ポリシーからの liveAvoid 復元と和集合を M1〜M7 として検証した。
#8 / #6 どちらの経由でも avoid={apne1, apne3} に収束すること (経路非依存)、和集合による fail-close、旧形式 (single-set 方式時代のポリシー) での [] 正規化、$distinct の重複除去、和集合 avoid での ovrTo 回帰をすべて確認した。

同日、TestState の Task 実行 (実 SDK 呼び出し) で `networkmanager:putCoreNetworkPolicy` に存在しない ID を渡し、エラー名が `NetworkManager.ResourceNotFoundException` と返ることを観測した。
これにより、PutPolicyConflict が catch する `NetworkManager.ConflictException` が用いるエラー名の接頭辞規則 (`NetworkManager.`) を実測で確認した。
ConflictException 自体は API リファレンス記載のエラーであり、README 実機検証 12 は解消済みである。

2026-07-18 実施分 (SFN 変数スコープ違反の修正 = preflight B)。
外側 (Aggregate) で Assign した `$agg` と同名の変数を MergeLiveAvoid (Parallel ブランチ内) で再 Assign する構成が SFN の Variables 仕様違反であることが判明した。
修正前の ASL は `validate-state-machine-definition` が `DUPLICATE_VARIABLE_NAME` (ERROR) で拒否しており、デプロイ時に CreateStateMachine で確実に失敗するバグだった。
束縛先を `$aggEff` へ改名し、fail-close の Pass を FailClose (ヘルスチェック単独判定の高速パスで $agg を参照) と FailCloseEffective (和集合判定で $aggEff を参照) に分離して解消した。修正後の ASL は result: OK である。
リネーム後の式は TestState で再検証し、全件パスした。P1〜P3 は MergeLiveAvoid の liveAvoid 復元と和集合、P4〜P5 は AlreadyApplied の冪等判定、P6 は avoid={apne1} の ovrTo 5 エントリ / ovrVia 4 エントリ生成を確認した。
GetLivePolicy の `$parse` 分岐は、PolicyDocument が JSON 文字列 / オブジェクトどちらの応答形でも正しくオブジェクト化されることを合成入力の TestState で確認した。
検証用 Core Network を削除済みだったため、実応答での確認は次回デプロイ後の初回実行ログで行う (README 実機検証 17)。

### 冪等判定の $count ガード除去

当初の冪等判定は `$count($liveVia) > 0 ? $liveVia = $desiredVia : false` だった。
この形は目標ポリシーの override が空のとき恒偽になり、avoidRegions が空でなくても毎サイクル PutPolicy を繰り返す、実行は成功し続けるため気付きにくい障害を招く。
現構成では目標ポリシーの override が空になる到達経路はないが、将来 NFG なしリージョンへヘルスチェックを追加すると顕在化するため、`$liveVia = $desiredVia` の直接比較に変更した。
V11 / V12 で「空同士は一致、片方だけ空は不一致」を実証した。
send-to 側は目標ポリシーの override が常に全エッジ分の 5 エントリで空にならないため、この変更による回帰はない。

### TestState では検証できない残項目

デプロイ後の実機検証に委ねる。対応する README の実機検証項目の番号を各項目に示す。

1. per-edge override / 自己参照 override を PutCoreNetworkPolicy が受理するか、default priority より優先されるか。baseline 側の受理は CloudFormation デプロイで確認する (README 実機検証 2 / 6 / 19)
2. cross-region Lambda invoke の実 Payload がハンドラーソースの確認どおりパース済みオブジェクトで返るか (README 実機検証 3)
3. DescribeRouteTables 実応答で Gateway Load Balancer のエンドポイントが GatewayId に入るか。Terraform Provider ソースでは確認済みである (README 実機検証 4)
4. 同一 AZ 固定 (AZ pinning) / FLOW ログ / RTO 計測 (README 実機検証 1 / 5)
5. send-via per-pair が依存する未文書挙動 4 点はオーケストレーター経由のフェイルオーバーで確認済みである。エッジの複数エントリ重複の受理 (確認済み)、set 外 use-edge-location の受理 (確認済み)、カバー外ペアがデフォルトの検査先へフォールバックすること (確認済み、ブラックホール化せず)、多重マッチの優先順位 (avoid={apne1} で FIB から use1 が採用されたことを確認。avoid={use1} は未検証)。各項目の意味と具体例は [send-via-override-research.md](send-via-override-research.md) の「公式ドキュメントに記載がなかった事項」を参照 (README 実機検証 13 / 14 / 15)
