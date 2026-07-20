# send-via の with-edge-overrides 調査記録 (2026-07-09 起票 / 2026-07-15 更新)

send-via (east-west 検査) のフェイルオーバー override を「全エッジ 1 set → 次点リージョン」から「ペア単位で健全なローカル NFG を維持する形」へ最適化できるかを調査した記録である。
2026-07-12 に方式 C (per-pair) を採用済みである。
公式に記載のない挙動 4 点はデプロイ後の実機検証で確定させる。
当初は、未文書挙動への依存と受理されないリスクを理由に見送っていた。その経緯は「判断の経緯」の節に時系列で残す。

## 問題意識

初期実装 (single-set 方式) は、両 AZ 障害リージョンがあると send-via の全ペアを failoverTarget へ向ける。
このため健全なリージョン同士のペアもクロスリージョン迂回になる。
例として、ap-northeast-3 のみ両 AZ 障害で target = us-east-1 のとき、ap-northeast-1 のローカル NFG は健全であるにもかかわらず、ap-northeast-1 ↔ us-west-2 の east-west まで us-east-1 検査に迂回する。

## 仕様調査の結果 (公式ドキュメントの網羅調査)

### 確認できた事実

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| edge-sets の型 | "Array of arrays of strings" (外側に複数 set を入れられる構造) | [API: EdgeOverride](https://docs.aws.amazon.com/networkmanager/latest/APIReference/API_EdgeOverride.html) |
| override エントリの複数化 | WithEdgeOverrides は "Array of EdgeOverride" <br>コンソールにも「Add で追加」の手順あり | [API: Via](https://docs.aws.amazon.com/networkmanager/latest/APIReference/API_Via.html) / [segment actions](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policy-network-actions-routes.html) |
| send-to の set 外 use-edge-location | 公式ブログに実例あり (`edge-sets: [["us-west-1"]]` → `use-edge-location: "us-west-2"`) | [Greenfield egress ブログ](https://aws.amazon.com/blogs/networking-and-content-delivery/simplifying-egress-inspection-with-aws-cloud-wan-service-insertion-for-greenfield-deployments/) |
| send-via の公式サンプル | 2 エッジ 1 set + set 内メンバーを preferred に指定する形のみ | [policies-json](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policies-json.html) |
| デフォルトの Region priority list | What is Cloud WAN の Region availability テーブルの掲載順 | [what-is-cloudwan](https://docs.aws.amazon.com/network-manager/latest/cloudwan/what-is-cloudwan.html) |
| アタッチメントのない NFG への send-to / send-via アクション | ポリシー適用は成功するがトラフィックはブラックホール化する | [service-insertion](https://docs.aws.amazon.com/network-manager/latest/cloudwan/cloudwan-policy-service-insertion.html) |

### 公式ドキュメントに記載がなかった事項 (方式 C が依存する未文書挙動 4 点)

公式ドキュメントの send-via サンプルは「エントリ 1 個、use-edge-location はその set のメンバー」という形しか示していない。
方式 C (per-pair) が生成するポリシーはそこから 4 つの点で逸脱しており、いずれも受理可否や動作が文書化されていない。
具体例として、avoid={ap-northeast-1} のとき方式 C は次の 4 エントリを書き込む。以降の説明はこの例を使う。

```json
[
  { "edge-sets": [["us-west-2", "ap-northeast-1"]],      "use-edge-location": "us-east-1" },
  { "edge-sets": [["ap-northeast-1", "ap-northeast-3"]], "use-edge-location": "ap-northeast-3" },
  { "edge-sets": [["ap-northeast-1", "ap-southeast-1"]], "use-edge-location": "us-east-1" },
  { "edge-sets": [["ap-northeast-1"]],                   "use-edge-location": "us-east-1" }
]
```

1. **同一エッジが複数エントリの edge-sets に重複登場してよいか** (実機検証 13)。
   上の例では ap-northeast-1 が 4 エントリすべてに登場する。
   同じエッジを複数エントリに書いてよいとはどこにも書かれておらず、PutCoreNetworkPolicy のバリデーターがポリシーごと拒否する可能性がある。
   拒否されるとフェイルオーバー自体が失敗する。
2. **複数エントリにマッチした場合の優先順位 / 競合解決ルール** (実機検証 15)。
   1 つの通信が複数エントリに同時にマッチし得る。
   上の例で ap-northeast-1 内の VPC 同士の通信は、両端のエッジがどちらも ap-northeast-1 のため 4 エントリすべてに含まれ、指す検査先が us-east-1 と ap-northeast-3 で一致しない。
   どのエントリが優先されるかの規則は文書化されていない。
   ただし設計検証で、値が一致しないのは障害中のリージョン内部の通信だけで、候補はすべて健全リージョンであることを確認済みである。
   検査されること自体は保たれ、どこで検査されるかが予測できないだけである。
   どこで検査されたかは Network Firewall (以下 NFW) の ALERT ログで観測する。
3. **send-via で set 外の use-edge-location を指定できるか** (実機検証 13)。
   1 番目のエントリは set が {us-west-2, ap-northeast-1} なのに、検査先は set のメンバーでない us-east-1 である。
   ap-northeast-1 が障害中である以上、第三のリージョンへ迂回させるしかないためこの形になる。
   send-to にはこの書き方の公式実例 (Greenfield ブログのシナリオ 3) があるが、send-via では実例がない。
   受理されない可能性と、受理されてもトラフィックが流れない可能性の両方が残る。
4. **edge-sets でカバーされないペアがデフォルトの検査先へフォールバックするか** (実機検証 14)。4 点の中で最も深刻である。
   方式 C は検査先が障害中のペアしか書かないため、上の例では us-east-1 ↔ ap-northeast-3 のペアはどのエントリにも含まれない。
   期待は「エントリの無いペアは override なしと同じデフォルト規則 (両端の優先上位) で検査される」だが、これも明文化されていない。
   override を 1 つでも書くと、カバー外ペアがデフォルトに戻らずブラックホール化する、という最悪の可能性が残っている。
   過去の別検証に、edge-set 外経路がブラックホール化したことを疑わせる観測が未確定のまま残っている。
   もしそうなら健全リージョン同士の通信まで断たれるため、方式 C は成立しない。

以下、これらを未知 1〜4 と呼ぶ。

**2026-07-20 実機検証結果**: オーケストレーター経由のフェイルオーバー (avoid={ap-northeast-1}) で未知 1 / 3 / 4 の受理と正常動作を確認した (evidence/ap-northeast-1ダウン時)。未知 2 (多重マッチの優先順位) は avoid={apne1} で FIB から use1 が採用されたことを確認した (apne1 エッジの apne1 VPC 宛 CIDR がすべて us-east-1/INSPECTION)。avoid={use1} の自己ペアは未検証。カバー外ペアのブラックホール化は発生せず、方式 C を single-set に戻す必要はない。

未知 1 / 3 / 4 のいずれかで期待どおりの挙動が得られない場合は per-pair を諦め、config.ts の `SEND_VIA_OVERRIDE_MODE` を single-set へ戻して再デプロイする。
single-set は全エッジを 1 つの set に入れて failoverTarget へ向ける方式で、カバー外ペアが存在せず use-edge-location も set 内であり、公式サンプルと同形のため受理リスクが最小である。
代償として、健全リージョン同士のペアまでクロスリージョン迂回になる。

### 実機確認済みの関連知見 (過去の別検証)

- send-via の override は「edge-sets 内に両端があるペア」にのみ適用される。単一メンバー set は自己ペアのみに適用されるため、**send-via の per-edge 分割 (send-to と同じ形) は不可能**である
- Service Insertion のデフォルト選択: 両端検査あり → 優先リスト上位 / 片方のみ → その側 / 両端なし → 優先 #1
- Inspection VPC をデタッチしても自動フォールバックせずブラックホール化する。復旧にはポリシー再適用が必須である

## 検討した方式

### 方式 A (single-set): 全エッジ 1 set → failoverTarget

```json
[{ "edge-sets": [["us-east-1","us-west-2","ap-northeast-1","ap-northeast-3"]], "use-edge-location": "<target>" }]
```

注記: 上の JSON は ap-southeast-1 追加前の 4 リージョン時点の例である。現行構成で single-set に戻す場合は 5 エッジになる。

- 全ペアをカバーし target が常に健全であるため、カバー外ペアが構造上存在しない
- use-edge-location が set のメンバーであるため、公式サンプルと同形で受理リスクが最小になる
- 欠点は、健全ペアもクロスリージョン迂回になりレイテンシが非最適になる点である

### 方式 B: 6 ペア網羅 override (最適化案)

注記: 方式 B は ap-southeast-1 追加前の 4 リージョン時点の検討記録である。現構成 (5 リージョン) ではクロスリージョンペアは 10 になる。

各ペア `[[x, y]]` に「両端のうち健全で優先度上位の端。どちらも不健全なら failoverTarget」を指定する。

- クロスリージョンペアは「両端を含む set」がちょうど 1 エントリになるため、**未知 2 (競合解決) は構造的に発生しない**
- クロスリージョンペアに限れば、残る未知は未知 1 (エッジの重複登場) と未知 3 (両端不健全ペアの set 外 target) の 2 つである
- **制約**: 同一リージョン内ペア (例: HealthCheck VPC ↔ Workload VPC) は複数エントリにマッチして検査リージョンが予測不能になる。ただし候補値はすべて健全 NFG なので正しさは保たれ、予測可能性のみが低下する
- 冪等判定 (AlreadyApplied) を send-via 側の deep-equal にも拡張する必要がある

### 方式 C: 最小 override (自然選択が障害リージョンに向くペアのみ)

- 未カバーペアのフォールバック挙動 (未知 4) に依存し、この挙動はブラックホール化の疑いがある。当初は却下したが、要件変更により採用した。経緯は「判断の経緯」の節を参照

## (記録) 方式 B を検討していた際の手順

以下は当時の設計案の記録である。フラグは方式 C の実装時に `SEND_VIA_OVERRIDE_MODE` (定数) として実現され、値 per-pair は最終的に方式 C を指す名称になった。

1. `config.ts` に `sendViaOverrideMode: "single-set" | "per-pair"` フラグを追加し、orchestrator の `$ovrVia` 生成と冪等判定を分岐する (デフォルトは single-set のまま)
2. デプロイ後、フェイルオーバーの切替前に手動 PutCoreNetworkPolicy で実験する
   - 実験 1: エッジが重複する複数エントリの受理可否 (未知 1)
   - 実験 2: 両端不健全ペアに set 外 use-edge-location を指定した場合の受理可否と実挙動を確認する (未知 3)。NFW ALERT ログ (`INSPECTED at <region>`) でペアごとの検査リージョンを実測する
   - 実験 3: 同一リージョン内ペアがどのエントリに解決されるかの観測
3. 実験がすべて期待通りならフラグを per-pair に切り替えて再デプロイする
4. 受理されない場合やブラックホール化する場合は single-set 継続を確定し、本ドキュメントに結果を追記する

## 期待値の例 (方式 B / apne3 のみ両 AZ 障害)

注記: この表も ap-southeast-1 追加前の 4 リージョン時点の 6 ペアの記録である。現構成 (5 リージョン) ではクロスリージョンペアは 10 になる。

| ペア | use-edge-location | 方式 A との差 |
| --- | --- | --- |
| use1-usw2 | us-east-1 | 同じ |
| use1-apne1 | us-east-1 | 同じ |
| use1-apne3 | us-east-1 | 同じ |
| usw2-apne1 | ap-northeast-1 | A は us-east-1 へ迂回 |
| usw2-apne3 | us-east-1 | 同じ (apne3 障害) |
| apne1-apne3 | ap-northeast-1 | A は us-east-1 へ迂回 |

## 判断の経緯

- 2026-07-09: 方式 B を設計した。未知 2 は構造的に回避できると判明したが、未知 1 / 3 は実機実験でしか確定できず、受理されない場合はフェイルオーバー機能全体が失われるリスクがあるため、検証プロジェクトの主目的であるフェイルオーバー動作の実証を先に完了させる方針とし、この時点では見送った。README の「今後の課題」に記載した。方式 C もこの時点で検討したが、未カバーペアのフォールバック挙動にブラックホール化の疑いがあることを理由に却下した
- 2026-07-12: 要件変更により**方式 C を採用して実装した**。要件変更の内容は、ap-northeast-1 障害時に健全な ap-northeast-3 のローカル検査を維持することが必須になった点である。全 8 avoid セットの機械検証で、ブラックホール化ゼロ / 正常な self-pair のローカル維持 / 見落としゼロを確認した。値が一致しない多重マッチは障害中のリージョン自身の self-pair の 2 ケースのみで、候補値はすべて健全であり安全側である。TestState では、生成が発生する 7 通りの avoid セットの `$ovrVia` 生成と拡張 alreadyApplied を検証済みである ([failure-scenarios.md](failure-scenarios.md) の V1〜V10。全 3 リージョン avoid は fail-close により PutPolicy に到達しないため対象外)。未文書挙動 (エントリ重複 / set 外 use-edge-location / カバー外ペアのフォールバック / 多重マッチ優先順位) はデプロイ後の実機検証項目とし、受理されない場合は config.ts の `SEND_VIA_OVERRIDE_MODE` を single-set へ戻して再デプロイする
- 2026-07-15: 非 NFG リージョン ap-southeast-1 を追加した。「両端なし → #1」の実機根拠が egress の観測のみで、両端 NFG なしの VPC ペアでの直接観測が構成上不可能だったためである。usw2 内 self-pair は「同一リージョン内通信が検査されない可能性」(README の実機検証 9) と論点が重なる。usw2 ↔ apse1 のクロスペアでこの組み合わせを観測する (README の実機検証 18)
- 2026-07-15 (2): baseline の send-to に per-edge override を常設した。これによりヘルスチェックの障害帰属を修正し、apse1 の egress を apne1 経由に変更した。send-via 側のレイテンシ最適化として apse1 内と usw2↔apse1 のペアを apne1 経由へ切り替える案は、次の 2 点を理由に見送り、将来対応として README の「今後の課題」に記録した。理由 1 は、set 外 use-edge-location の send-via での受理が未文書であること (実機検証 13)。理由 2 は、usw2↔apse1 のデフォルト #1 挙動そのものが apse1 追加の観測目的であること (実機検証 18)。両検証の完了後、受理が確認できればペア [[apse1]] と [[usw2,apse1]] に use-edge-location: ap-northeast-1 を追加する形で再開する
