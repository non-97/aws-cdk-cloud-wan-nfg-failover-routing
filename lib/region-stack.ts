import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { RegionConfig } from "./config";
import {
  HealthCheckVpc,
  InspectionVpc,
  NatGatewayRef,
  ProbeFunctionRef,
  WorkloadVpc,
} from "./constructs";

export interface RegionStackProps extends cdk.StackProps {
  /** このリージョンのネットワーク設定 */
  readonly regionConfig: RegionConfig;
  /** Cloud WAN Core Network ID (CoreStack から) */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN (CoreStack から) */
  readonly coreNetworkArn: string;
}

/**
 * リージョン汎用 Stack。全リージョンで Workload VPC を作り、
 * inspectionCidr を持つ (NFG あり) リージョンでは Inspection VPC + HealthCheck VPC も作る。
 *
 * HealthCheck VPC の各 AZ Lambda の ARN を公開し、OrchestratorStack が
 * crossRegionReferences 経由で参照して invoke する。
 */
export class RegionStack extends cdk.Stack {
  /** このリージョンのヘルスチェック Lambda 参照 (NFG なしリージョンは空配列) */
  public readonly probeFunctions: ProbeFunctionRef[];
  /** このリージョンの unhealthy 継続アラーム ARN (NFG なしリージョンは undefined) */
  public readonly probeAlarmArn?: string;
  /** このリージョンの Network Firewall 名 (NFG なしリージョンは undefined) */
  public readonly firewallName?: string;
  /** このリージョンの NAT ゲートウェイ (NFG なしリージョンは空配列) */
  public readonly natGateways: NatGatewayRef[];

  constructor(scope: Construct, id: string, props: RegionStackProps) {
    super(scope, id, props);

    const { regionConfig, coreNetworkId, coreNetworkArn } = props;

    regionConfig.workloadCidrs.forEach((cidr, index) => {
      new WorkloadVpc(this, `WorkloadVpc${index + 1}`, {
        vpcCidr: cidr,
        availabilityZones: regionConfig.availabilityZones,
        coreNetworkId,
        coreNetworkArn,
      });
    });

    if (regionConfig.inspectionCidr && regionConfig.healthCheckCidr) {
      const inspection = new InspectionVpc(this, "InspectionVpc", {
        vpcCidr: regionConfig.inspectionCidr,
        availabilityZones: regionConfig.availabilityZones,
        coreNetworkId,
        coreNetworkArn,
        regionLabel: regionConfig.region,
      });
      this.firewallName = inspection.firewallName;
      this.natGateways = inspection.natGateways;

      const healthCheck = new HealthCheckVpc(this, "HealthCheckVpc", {
        vpcCidr: regionConfig.healthCheckCidr,
        availabilityZones: regionConfig.availabilityZones,
        coreNetworkId,
        coreNetworkArn,
      });
      this.probeFunctions = healthCheck.probeFunctions;
      this.probeAlarmArn = healthCheck.probeAlarmArn;
    } else {
      this.probeFunctions = [];
      this.natGateways = [];
    }
  }
}
