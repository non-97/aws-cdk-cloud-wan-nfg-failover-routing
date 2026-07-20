#!/usr/bin/env bash
#
# Cloud WAN コアネットワークの「ルーティング情報ベース (RIB)」をセグメント × リージョンごとに取得する。
# get-fib.sh (FIB = 確定ルート) と違い、BGP 属性 (Local Preference / AS Path / MED / Community) 付きの
# 候補ルートを見せる。Service Insertion のリージョン選択がどの属性で決まっているかの考察に使う。
#
# 使い方:
#   awsume <profile> && aws sts get-caller-identity   # 認証
#   ./scripts/get-rib.sh
#
set -uo pipefail

# Network Manager (Cloud WAN) のグローバル API リージョン。
NM_REGION=${NM_REGION:-us-west-2}

SEGMENT=workload
# RIB はセグメント単位 (NFG 指定は無い)。セグメントは全エッジに存在。
SEGMENT_EDGES=(us-east-1 us-west-2 ap-northeast-1 ap-northeast-3 ap-southeast-1)

CORE_NETWORK_ID=$(aws networkmanager list-core-networks --region "$NM_REGION" \
  --query 'CoreNetworks[0].CoreNetworkId' --output text)
echo "CoreNetwork=$CORE_NETWORK_ID  (NM_REGION=$NM_REGION)"

# console の RIB 列に対応: Prefix / NextHop(エッジ・セグメント・種別) / LocalPref / MED / ASパス / Community
# AsPath はスペース区切り。JMESPath はバッククォート内の前後空白を除去するため、
# 素の ` ` ではなく JSON 文字列リテラル `" "` を使う (これをしないと ASN が連結される)。
QUERY='CoreNetworkRoutingInformation[].{Prefix:Prefix,Edge:NextHop.EdgeLocation,Seg:NextHop.SegmentName,Type:NextHop.ResourceType,LocalPref:LocalPreference,Med:Med,AsPath:join(`" "`,AsPath||`[]`),Comm:join(`,`,Communities||`[]`)}'

for EDGE in "${SEGMENT_EDGES[@]}"; do
  echo "===== RIB  SEGMENT=$SEGMENT  EDGE=$EDGE ====="
  aws networkmanager list-core-network-routing-information --region "$NM_REGION" \
    --core-network-id "$CORE_NETWORK_ID" \
    --segment-name "$SEGMENT" \
    --edge-location "$EDGE" \
    --query "$QUERY" --output table
done
