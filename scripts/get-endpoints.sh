#!/usr/bin/env bash
#
# 各リージョンの EC2 インスタンス (プライベート IP) と NAT Gateway (パブリック IP) の一覧を
# VPC / AZ 別にテーブル表示する。
#
# 必要ツール: aws-cli, jq, column
# 使い方:
#   awsume <profile> && aws sts get-caller-identity
#   ./scripts/get-endpoints.sh
#
set -uo pipefail

REGIONS=(us-east-1 us-west-2 ap-northeast-1 ap-northeast-3 ap-southeast-1)

echo "=============================="
echo " EC2 Instances (Private IP)"
echo "=============================="
echo

for region in "${REGIONS[@]}"; do
  instances=$(aws ec2 describe-instances \
    --region "$region" \
    --filters "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].{
      Name: Tags[?Key==`Name`].Value | [0],
      InstanceId: InstanceId,
      AZ: Placement.AvailabilityZone,
      PrivateIp: PrivateIpAddress,
      VpcId: VpcId
    }' \
    --output json)

  count=$(echo "$instances" | jq length)
  if [ "$count" -eq 0 ]; then
    continue
  fi

  echo "--- $region ($count instances) ---"
  echo "$instances" | jq -r '
    ["NAME","INSTANCE-ID","AZ","PRIVATE-IP","VPC-ID"],
    (sort_by(.AZ, .Name)[] | [
      (.Name // "-"),
      .InstanceId,
      .AZ,
      .PrivateIp,
      .VpcId
    ]) | @tsv' \
  | column -t -s $'\t'
  echo
done

echo "=============================="
echo " NAT Gateways (Public IP)"
echo "=============================="
echo

for region in "${REGIONS[@]}"; do
  natgws=$(aws ec2 describe-nat-gateways \
    --region "$region" \
    --filter "Name=state,Values=available" \
    --query 'NatGateways[].{
      NatGatewayId: NatGatewayId,
      AZ: SubnetId,
      VpcId: VpcId,
      PublicIp: NatGatewayAddresses[0].PublicIp,
      PrivateIp: NatGatewayAddresses[0].PrivateIp,
      SubnetId: SubnetId
    }' \
    --output json)

  count=$(echo "$natgws" | jq length)
  if [ "$count" -eq 0 ]; then
    continue
  fi

  # SubnetId から AZ を引く
  subnet_ids=$(echo "$natgws" | jq -r '.[].SubnetId' | sort -u | tr '\n' ' ')
  az_map=$(aws ec2 describe-subnets \
    --region "$region" \
    --subnet-ids $subnet_ids \
    --query 'Subnets[].{SubnetId: SubnetId, AZ: AvailabilityZone}' \
    --output json)

  vpc_ids=$(echo "$natgws" | jq -r '.[].VpcId' | sort -u | tr '\n' ' ')
  vpc_names=$(aws ec2 describe-vpcs \
    --region "$region" \
    --vpc-ids $vpc_ids \
    --query 'Vpcs[].{VpcId: VpcId, Name: Tags[?Key==`Name`].Value | [0]}' \
    --output json)

  echo "--- $region ($count NAT Gateways) ---"
  jq -n -r \
    --argjson natgws "$natgws" \
    --argjson azmap "$az_map" \
    --argjson vpcnames "$vpc_names" '
    ($azmap | map({(.SubnetId): .AZ}) | add // {}) as $az |
    ($vpcnames | map({(.VpcId): (.Name // "-")}) | add // {}) as $vn |
    ["VPC-NAME","NAT-GW-ID","AZ","PUBLIC-IP","PRIVATE-IP"],
    ($natgws | sort_by(.SubnetId)[] | [
      ($vn[.VpcId] // "-"),
      .NatGatewayId,
      ($az[.SubnetId] // "-"),
      (.PublicIp // "-"),
      (.PrivateIp // "-")
    ]) | @tsv' \
  | column -t -s $'\t'
  echo
done
