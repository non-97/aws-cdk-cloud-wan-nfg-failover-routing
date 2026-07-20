/**
 * Core Network Policy ドキュメント (baseline) を生成する純関数。
 *
 * baseline = 平常時の初期ポリシー。CDK synth (CoreStack の初期ポリシー) で使う。
 * send-to には per-edge override (各エッジ → 優先 NFG) を常設し、send-via の override は持たない。
 * フェイルオーバー時の override 生成はランタイム (JSONata Step Functions) 側で行う
 * (send-to は preferredNfgByEdge() を共有し、avoid が空なら baseline と同一になる)。
 *
 * 最小ポリシー構成:
 * - segment      : workload (全 Workload / HealthCheck VPC を収容)
 * - NFG          : inspection (Inspection VPC を収容)
 * - create-route : RFC1918 全帯を blackhole (未使用帯宛のドロップ)
 * - send-to      : workload からインターネット向け (0.0.0.0/0) を NFG 経由に
 * - send-via     : workload 同士の east-west を single-hop で NFG 経由に
 */

import {
  CLOUDWAN,
  REGION_CONFIGS,
  RFC1918_CIDRS,
  preferredNfgByEdge,
} from "./config";

/**
 * baseline の Core Network Policy ドキュメントを返す。
 * CfnCoreNetwork の policyDocument にそのまま渡す。
 */
export const buildBaselineCoreNetworkPolicy = (): Record<string, unknown> => {
  // send-to / send-via 共通の via ベース。send-via はこのまま使い、
  // send-to は with-edge-overrides を追加して使う。
  const via = {
    "network-function-groups": [CLOUDWAN.nfg],
  };

  return {
    version: "2025.11",
    "core-network-configuration": {
      "asn-ranges": [CLOUDWAN.asnRange],
      // CloudFormation 経由の適用では省略可 (デフォルト true) だが、フェイルオーバー時の
      // 直接 PutCoreNetworkPolicy は 2025.11 でこの 2 キーを必須とする (実機確認済み)。
      // 省略するとフェイルオーバー実行時に初めて検証エラーになるため明示する
      "dns-support": true,
      "security-group-referencing-support": true,
      "edge-locations": REGION_CONFIGS.map((r) => ({
        location: r.region,
        asn: r.asn,
      })),
    },
    segments: [
      {
        name: CLOUDWAN.segment,
        "require-attachment-acceptance": false,
        // send-via (east-west 検査) はセグメント内アタッチメント同士の通信が前提のため、
        // isolate-attachments: false を明示する (2025.11 のバリデーション要件)。
        "isolate-attachments": false,
        "edge-locations": REGION_CONFIGS.map((r) => r.region),
      },
    ],
    "network-function-groups": [
      {
        name: CLOUDWAN.nfg,
        "require-attachment-acceptance": false,
      },
    ],
    "segment-actions": [
      {
        // RFC1918 全帯の blackhole 静的ルートを常設する。実在する VPC の CIDR は
        // 伝播ルートがロンゲストマッチで勝つため east-west と egress に影響せず、
        // ネットワーク内に存在しない RFC1918 宛だけが確実にドロップされる。
        // 目的は 2 つ: (1) 未使用帯宛の通信が send-to の 0.0.0.0/0 に乗って
        // Inspection VPC と Core Network の間を往復することの防止、
        // (2) セグメントを増やしたときに NFG 折り返しで意図しないセグメント間
        // 通信が成立することの防止。
        // 注意: VPN / DX を接続する構成では、同一プレフィックスの広報経路より
        // 静的ルートが優先されて blackhole が勝つ (README の本番転用時の制約)。
        // description は policy の制約により ASCII のみ
        action: "create-route",
        segment: CLOUDWAN.segment,
        "destination-cidr-blocks": [...RFC1918_CIDRS],
        destinations: ["blackhole"],
        description: "Drop unused RFC1918 space to prevent NFG hairpin and loops",
      },
      {
        action: "send-to",
        segment: CLOUDWAN.segment,
        // 平常時から per-edge override を常設する。デフォルトの egress は全エッジが
        // 優先度 #1 へ向かうため (実機確認済み)、(1) probe が自リージョンの NFG を
        // 検査できず単一リージョン障害が fail-close に誤判定される、(2) 遠隔リージョン
        // 経由でレイテンシが悪化する。各エッジを優先 NFG (NFG あり = 自身 /
        // なし = 最近傍) へ固定して両方を解決する
        via: {
          ...via,
          "with-edge-overrides": REGION_CONFIGS.map((r) => ({
            "edge-sets": [[r.region]],
            "use-edge-location": preferredNfgByEdge()[r.region],
          })),
        },
      },
      {
        action: "send-via",
        segment: CLOUDWAN.segment,
        mode: "single-hop",
        "when-sent-to": { segments: [CLOUDWAN.segment] },
        via,
      },
    ],
    "attachment-policies": [
      {
        "rule-number": 100,
        description: "attach workload segment by tag",
        "condition-logic": "or",
        conditions: [
          {
            type: "tag-value",
            operator: "equals",
            key: CLOUDWAN.tagKey.segment,
            value: CLOUDWAN.segment,
          },
        ],
        action: { "association-method": "constant", segment: CLOUDWAN.segment },
      },
      {
        "rule-number": 200,
        description: "add to inspection NFG by tag",
        "condition-logic": "or",
        conditions: [
          {
            type: "tag-value",
            operator: "equals",
            key: CLOUDWAN.tagKey.nfg,
            value: CLOUDWAN.nfg,
          },
        ],
        action: { "add-to-network-function-group": CLOUDWAN.nfg },
      },
    ],
  };
};
