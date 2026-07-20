#!/usr/bin/env bash
#
# Cloud WAN Core Network の FIB (確定ルート = get-network-routes) をセグメント / NFG × リージョンごとに取得し、
# 次ホップを「どのリージョンの Inspection VPC (検査先) か」が一目で分かる形に解決して表示する。
# 候補ルート (BGP 属性付き) を見たい場合は get-rib.sh を使う。
#
# セグメントのルートテーブルは次ホップを attachment-id でしか返さない (EdgeLocation を埋めない) ため、
# list-attachments のタグ (cloudwan-nfg=inspection) から各アタッチメントの region と役割を引き、
# NEXT-HOP 列に "<region>/INSPECTION" 等を表示する。
#
# 必要ツール: aws-cli, jq
# 使い方:
#   awsume <profile> && aws sts get-caller-identity
#   ./scripts/get-fib.sh
#
set -uo pipefail

# Network Manager (Cloud WAN) のグローバル API リージョン。
NM_REGION=${NM_REGION:-us-west-2}

SEGMENT=workload
NFG=inspection
# セグメントは全エッジに存在 / NFG は Inspection VPC を持つ 3 リージョンのみ
SEGMENT_EDGES=(us-east-1 us-west-2 ap-northeast-1 ap-northeast-3 ap-southeast-1)
NFG_EDGES=(us-east-1 ap-northeast-1 ap-northeast-3)

CORE_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].CoreNetworkId' --output text)
GLOBAL_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].GlobalNetworkId' --output text)
echo "CoreNetwork=$CORE_NETWORK_ID  GlobalNetwork=$GLOBAL_NETWORK_ID  (NM_REGION=$NM_REGION)"

# attachment-id -> {region, role}。role は cloudwan-nfg タグの有無で INSPECTION / workload を判定。
ATT_JSON=$(aws networkmanager list-attachments --region "$NM_REGION" \
  --core-network-id "$CORE_NETWORK_ID" \
  --query 'Attachments[].{Id:AttachmentId,Region:EdgeLocation,Nfg:Tags[?Key==`cloudwan-nfg`].Value|[0]}' \
  --output json)
ATT_MAP=$(echo "$ATT_JSON" | jq 'map({(.Id): {region:.Region, role:(if .Nfg=="inspection" then "INSPECTION" else "workload" end)}}) | add // {}')

echo
echo "===== attachment 凡例 ====="
echo "$ATT_JSON" | jq -r '
  ["ATTACHMENT","REGION","ROLE"],
  (sort_by(.Region)[] | [.Id, .Region, (if .Nfg=="inspection" then "INSPECTION" else "workload" end)])
  | @tsv' | column -t -s $'\t'

# 指定ルートテーブルのルートを取得し、次ホップを <region>/ROLE に解決して表示する。
print_routes() {
  local rti="$1"
  aws networkmanager get-network-routes --region "$NM_REGION" \
    --global-network-id "$GLOBAL_NETWORK_ID" \
    --route-table-identifier "$rti" --output json \
  | jq -r --argjson att "$ATT_MAP" '
      ["CIDR","TYPE","STATE","NEXT-HOP","ATTACHMENT"],
      (.NetworkRoutes[] | . as $r | ($r.Destinations // []) as $d
        | ([ $d[]
              | if .CoreNetworkAttachmentId then
                  # アタッチメント宛: タグ由来の region/ROLE。ROLE=INSPECTION なら検査VPC。
                  (($att[.CoreNetworkAttachmentId]) // {region:"?",role:"?"} | "\(.region)/\(.role)")
                elif .EdgeLocation then
                  # NFG への次ホップ (コンソールの "inspection | <edge>" 相当)。
                  # 次ホップは Inspection NFG であり、EdgeLocation はその転送先エッジ。
                  # 分岐1 (具体的な検査VPCアタッチメント = <region>/INSPECTION) と区別するため NFG: 表記。
                  "NFG:\(.NetworkFunctionGroupName // "?")@\(.EdgeLocation)"
                else "blackhole" end
            ] | join(",")) as $nh
        | ([ $d[].CoreNetworkAttachmentId ] | join(",")) as $aid
        | [ $r.DestinationCidrBlock, $r.Type, $r.State,
            (if $nh=="" then "-" else $nh end),
            (if $aid=="" then "-" else $aid end) ]
      ) | @tsv' \
  | column -t -s $'\t'
}

# ===== セグメント workload × 各リージョン =====
for EDGE in "${SEGMENT_EDGES[@]}"; do
  echo
  echo "===== SEGMENT=$SEGMENT  EDGE=$EDGE ====="
  print_routes "CoreNetworkSegmentEdge={CoreNetworkId=$CORE_NETWORK_ID,SegmentName=$SEGMENT,EdgeLocation=$EDGE}"
done

# ===== NFG inspection × NFGアタッチメントを持つリージョン =====
# (detach フェーズや NFG の無いリージョンはルートテーブルが存在せずエラーになる = 想定どおり)
for EDGE in "${NFG_EDGES[@]}"; do
  echo
  echo "===== NFG=$NFG  EDGE=$EDGE ====="
  print_routes "CoreNetworkNetworkFunctionGroup={CoreNetworkId=$CORE_NETWORK_ID,NetworkFunctionGroupName=$NFG,EdgeLocation=$EDGE}"
done
