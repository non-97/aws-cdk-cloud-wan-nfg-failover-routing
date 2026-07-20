import * as cdk from "aws-cdk-lib/core";
import * as networkmanager from "aws-cdk-lib/aws-networkmanager";
import { Construct } from "constructs";
import { buildBaselineCoreNetworkPolicy } from "./core-network-policy";

/**
 * Cloud WAN の中核 (Global Network / Core Network + baseline Policy) を定義する Stack。
 *
 * 初期ポリシーは baseline。send-to には各エッジを優先 NFG へ向ける per-edge override を
 * 常設し、send-via の override は持たない。フェイルオーバー時の override はランタイム
 * (JSONata Step Functions) が PutCoreNetworkPolicy で適用する。coreNetworkId /
 * coreNetworkArn を公開し、各 RegionStack / OrchestratorStack が
 * crossRegionReferences 経由で参照する。
 */
export class CoreStack extends cdk.Stack {
  public readonly coreNetworkId: string;
  public readonly coreNetworkArn: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const globalNetwork = new networkmanager.CfnGlobalNetwork(
      this,
      "GlobalNetwork",
      {
        description: "NFG failover verification global network",
      },
    );

    const coreNetwork = new networkmanager.CfnCoreNetwork(this, "CoreNetwork", {
      description: "NFG failover verification core network",
      globalNetworkId: globalNetwork.attrId,
      policyDocument: buildBaselineCoreNetworkPolicy(),
    });

    this.coreNetworkId = coreNetwork.attrCoreNetworkId;
    this.coreNetworkArn = coreNetwork.attrCoreNetworkArn;
  }
}
