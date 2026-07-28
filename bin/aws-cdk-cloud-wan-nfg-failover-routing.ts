#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import {
  CORE_STACK_REGION,
  ORCHESTRATOR_REGION,
  REGION_CONFIGS,
} from "../lib/config";
import { CoreStack } from "../lib/core-stack";
import { RegionStack } from "../lib/region-stack";
import { NatGatewayRef } from "../lib/constructs";
import { OrchestratorStack, ProbeTarget } from "../lib/orchestrator-stack";
import { MonitoringStack } from "../lib/monitoring-stack";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Cloud WAN の中核 (Global Network / Core Network / baseline Policy)
const coreStack = new CoreStack(app, "NfgFailoverCoreStack", {
  env: { account, region: CORE_STACK_REGION },
  crossRegionReferences: true,
});

// 各リージョンの Workload / Inspection / HealthCheck VPC
const probeTargets: ProbeTarget[] = [];
const probeAlarmArns: string[] = [];
const firewallNames: Record<string, string> = {};
const natGateways: Record<string, NatGatewayRef[]> = {};
const nfgRegionStacks: RegionStack[] = [];
for (const regionConfig of REGION_CONFIGS) {
  const regionStack = new RegionStack(
    app,
    `NfgFailoverRegionStack-${regionConfig.region}`,
    {
      env: { account, region: regionConfig.region },
      regionConfig,
      coreNetworkId: coreStack.coreNetworkId,
      coreNetworkArn: coreStack.coreNetworkArn,
      crossRegionReferences: true,
    },
  );
  // Core Network / Policy が先に存在している必要がある
  regionStack.addDependency(coreStack);

  // NFG リージョンのヘルスチェック Lambda を Orchestrator へ集約
  if (regionStack.probeFunctions.length > 0) {
    nfgRegionStacks.push(regionStack);
    for (const probe of regionStack.probeFunctions) {
      probeTargets.push({
        region: regionConfig.region,
        azName: probe.azName,
        functionArn: probe.functionArn,
        functionName: probe.functionName,
      });
    }
    if (regionStack.probeAlarmArn) {
      probeAlarmArns.push(regionStack.probeAlarmArn);
    }
    if (regionStack.firewallName) {
      firewallNames[regionConfig.region] = regionStack.firewallName;
    }
    natGateways[regionConfig.region] = regionStack.natGateways;
  }
}

// フェイルオーバーのオーケストレーター (us-west-2)
const orchestratorStack = new OrchestratorStack(app, "NfgFailoverOrchestratorStack", {
  env: { account, region: ORCHESTRATOR_REGION },
  coreNetworkId: coreStack.coreNetworkId,
  coreNetworkArn: coreStack.coreNetworkArn,
  probeTargets,
  crossRegionReferences: true,
});
orchestratorStack.addDependency(coreStack);
// ヘルスチェック Lambda ARN の cross-region 参照 (SSM + カスタムリソース) が解決される前に
// Orchestrator がデプロイされないよう、NFG RegionStack に依存させる。
for (const regionStack of nfgRegionStacks) {
  orchestratorStack.addDependency(regionStack);
}

// 運用者向け監視ダッシュボード (us-west-2)。オーケストレーターと同一リージョンのため
// 通常の props 参照で足りる (Cloud WAN のメトリクスも us-west-2 に集約発行される)
const monitoringStack = new MonitoringStack(app, "NfgFailoverMonitoringStack", {
  env: { account, region: ORCHESTRATOR_REGION },
  stateMachine: orchestratorStack.stateMachine,
  orchestratorLogGroup: orchestratorStack.logGroup,
  coreNetworkId: coreStack.coreNetworkId,
  probeAlarmArns,
  probeTargets,
  firewallNames,
  natGateways,
  crossRegionReferences: true,
});
monitoringStack.addDependency(orchestratorStack);
for (const regionStack of nfgRegionStacks) {
  monitoringStack.addDependency(regionStack);
}
