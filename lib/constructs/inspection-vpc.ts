import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as networkfirewall from "aws-cdk-lib/aws-networkfirewall";
import * as networkmanager from "aws-cdk-lib/aws-networkmanager";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import {
  CLOUDWAN,
  FAILOVER_ROLE_INSPECTION_CWAN_RT,
  RFC1918_CIDRS,
} from "../config";

export interface InspectionVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** 使用する AZ 名 (順序が論理 AZ 識別子 a / b に対応。config.ts で固定) */
  readonly availabilityZones: readonly [string, string];
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
  /** どのリージョンで検査されたかをログ / タグで判別するためのラベル (例: us-east-1) */
  readonly regionLabel: string;
}

/**
 * Inspection VPC (2AZ) - Network Firewall による検査 + インターネット出口。
 * send-to (egress) と send-via single-hop (east-west) の両方の検査先となる。
 *
 * 各 AZ に NF エンドポイントと NAT Gateway を持ち、各 AZ の Cloud WAN アタッチメント
 * サブネットのルートテーブルは自 AZ の NF エンドポイントを向く。AZ 障害時はこの RT の
 * デフォルトルートを生存 AZ の NF エンドポイントへ ReplaceRoute で付け替える (タグで特定)。
 *
 * Appliance Mode を有効化し、Cloud WAN からの往復トラフィックの対称性 / 同 AZ pinning を保つ。
 */
export class InspectionVpc extends Construct {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: InspectionVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      availabilityZones: [...props.availabilityZones],
      natGateways: 2,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: "Firewall",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "CloudWanAttachment",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    // Network Firewall Rule Group: pass-all + ICMP/TLS を alert (検査リージョン判別用)。
    // alert msg にリージョンラベルを埋め込み、ログだけで検査リージョンを一意に特定できるようにする。
    const nfwRuleGroup = new networkfirewall.CfnRuleGroup(this, "NfwRuleGroup", {
      ruleGroupName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + "-Rg",
      capacity: 100,
      type: "STATEFUL",
      ruleGroup: {
        statefulRuleOptions: { ruleOrder: "STRICT_ORDER" },
        rulesSource: {
          rulesString:
            [
              `pass icmp any any -> any any (alert; sid:2000001; rev:1; msg:"INSPECTED at ${props.regionLabel} - ICMP";)`,
              `pass tls any any -> any any (ssl_state:client_hello; flow:to_server,established; alert; sid:2000002; rev:1; msg:"INSPECTED at ${props.regionLabel} - TLS";)`,
              "pass tcp any any -> any any (flow:not_established; sid:3000001; rev:1;)",
              "pass tcp any any -> any any (flow:established; sid:3000002; rev:1;)",
              "pass udp any any -> any any (sid:3000003; rev:1;)",
            ].join("\n") + "\n",
        },
      },
    });

    const nfwPolicy = new networkfirewall.CfnFirewallPolicy(this, "NfwPolicy", {
      firewallPolicyName:
        cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + "-Fp",
      firewallPolicy: {
        statelessDefaultActions: ["aws:forward_to_sfe"],
        statelessFragmentDefaultActions: ["aws:forward_to_sfe"],
        statefulDefaultActions: ["aws:drop_established"],
        statefulEngineOptions: { ruleOrder: "STRICT_ORDER" },
        statefulRuleGroupReferences: [
          { priority: 1, resourceArn: nfwRuleGroup.attrRuleGroupArn },
        ],
      },
    });

    // NF を 2AZ 化: 両 AZ の Firewall サブネットに endpoint を作る
    const fwSubnets = vpc.selectSubnets({ subnetGroupName: "Firewall" });
    const nfw = new networkfirewall.CfnFirewall(this, "Nfw", {
      firewallName: cdk.Names.uniqueResourceName(this, { maxLength: 16 }) + "-Nfw",
      firewallPolicyArn: nfwPolicy.attrFirewallPolicyArn,
      subnetMappings: fwSubnets.subnets.map((s) => ({ subnetId: s.subnetId })),
      vpcId: vpc.vpcId,
    });

    // ALERT (検査リージョン判別) + FLOW (往復経路 / 同 AZ pinning 確認) を CloudWatch Logs へ
    const alertLogGroup = new logs.LogGroup(this, "NfwAlertLogGroup", {
      // 監査要件を想定した 1 年保持 + 残置 (config.ts の MONITORING.logRetentionDays)
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const flowLogGroup = new logs.LogGroup(this, "NfwFlowLogGroup", {
      // 監査要件を想定した 1 年保持 + 残置 (config.ts の MONITORING.logRetentionDays)
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new networkfirewall.CfnLoggingConfiguration(this, "NfwLogging", {
      firewallArn: nfw.ref,
      loggingConfiguration: {
        logDestinationConfigs: [
          {
            logDestination: { logGroup: alertLogGroup.logGroupName },
            logDestinationType: "CloudWatchLogs",
            logType: "ALERT",
          },
          {
            logDestination: { logGroup: flowLogGroup.logGroupName },
            logDestinationType: "CloudWatchLogs",
            logType: "FLOW",
          },
        ],
      },
    });

    // 各 AZ の NF endpoint ID を DescribeFirewall (SyncStates) で正確に取得する。
    // attrEndpointIds は AZ 順序が保証されないため、AZ 名キーでアクセスできる SyncStates を使う。
    // outputPaths で必要フィールドのみに絞り、AwsCustomResource の 4096 byte 制限を回避する。
    const endpointPaths = vpc.availabilityZones.map(
      (az) => `FirewallStatus.SyncStates.${az}.Attachment.EndpointId`,
    );
    const describeFw = new cr.AwsCustomResource(this, "DescribeFwEndpoints", {
      onUpdate: {
        service: "network-firewall",
        action: "DescribeFirewall",
        parameters: { FirewallArn: nfw.attrFirewallArn },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${nfw.attrFirewallArn}-endpoints`,
        ),
        outputPaths: endpointPaths,
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    describeFw.node.addDependency(nfw);

    // Cloud WAN VPC Attachment (両 AZ subnet / inspection NFG へタグ自動割当 / Appliance Mode)
    const cwSubnets = vpc.selectSubnets({ subnetGroupName: "CloudWanAttachment" });
    const attachment = new networkmanager.CfnVpcAttachment(
      this,
      "CloudWanAttachment",
      {
        coreNetworkId: props.coreNetworkId,
        vpcArn: vpc.vpcArn,
        subnetArns: cwSubnets.subnets.map((s) =>
          cdk.Arn.format(
            { service: "ec2", resource: "subnet", resourceName: s.subnetId },
            cdk.Stack.of(this),
          ),
        ),
        options: { applianceModeSupport: true },
        tags: [{ key: CLOUDWAN.tagKey.nfg, value: CLOUDWAN.nfg }],
      },
    );

    // 各 AZ のルーティング + フェイルオーバー用タグ
    vpc.availabilityZones.forEach((az, index) => {
      const azLetter = String.fromCharCode(97 + index); // 0 -> 'a', 1 -> 'b'
      const suffix = azLetter.toUpperCase();
      const fwSubnet = vpc.selectSubnets({
        subnetGroupName: "Firewall",
        availabilityZones: [az],
      }).subnets[0];
      const cwSubnet = vpc.selectSubnets({
        subnetGroupName: "CloudWanAttachment",
        availabilityZones: [az],
      }).subnets[0];
      const pubSubnet = vpc.selectSubnets({
        subnetGroupName: "Public",
        availabilityZones: [az],
      }).subnets[0];

      const fwEndpointId = describeFw.getResponseField(
        `FirewallStatus.SyncStates.${az}.Attachment.EndpointId`,
      );

      // CloudWanAttachment RT: Core Network からの流入を自 AZ の NF endpoint へ (= ReplaceRoute 対象)
      new ec2.CfnRoute(this, `CwSubnetDefaultRoute${suffix}`, {
        routeTableId: cwSubnet.routeTable.routeTableId,
        destinationCidrBlock: "0.0.0.0/0",
        vpcEndpointId: fwEndpointId,
      });

      // Public RT: NAT GW からのリターン (RFC1918) を自 AZ の NF endpoint へ戻す
      new ec2.CfnRoute(this, `PublicSubnetInternalRoute${suffix}`, {
        routeTableId: pubSubnet.routeTable.routeTableId,
        destinationCidrBlock: "10.0.0.0/8",
        vpcEndpointId: fwEndpointId,
      });

      // Firewall RT: 検査後の内部宛 (RFC1918) を Core Network へ
      // (インターネット宛 0.0.0.0/0 -> 自 AZ NAT GW は L2 が自動設定)
      const fwInternalRoute = new ec2.CfnRoute(
        this,
        `FwSubnetInternalRoute${suffix}`,
        {
          routeTableId: fwSubnet.routeTable.routeTableId,
          destinationCidrBlock: "10.0.0.0/8",
          coreNetworkArn: props.coreNetworkArn,
        },
      );
      fwInternalRoute.addDependency(attachment);

      // 10.0.0.0/8 以外の RFC1918 帯の戻りルート。既存の 10.0.0.0/8 ルートは
      // 論理 ID 維持のため上のブロックに残し、ここでは残り 2 帯だけ追加する。
      // 論理 ID を変えると CloudFormation が新規作成を先に行い、同一宛先ルートの
      // 重複で RouteAlreadyExists になりデプロイが失敗する。
      RFC1918_CIDRS.filter((cidr) => cidr !== "10.0.0.0/8").forEach(
        (cidr, cidrIndex) => {
          // Public RT: NAT GW からのリターンを自 AZ の NF endpoint へ戻す
          new ec2.CfnRoute(this, `PubRfc1918Route${suffix}${cidrIndex}`, {
            routeTableId: pubSubnet.routeTable.routeTableId,
            destinationCidrBlock: cidr,
            vpcEndpointId: fwEndpointId,
          });
          // Firewall RT: 検査後の内部宛を Core Network へ
          const fwRoute = new ec2.CfnRoute(
            this,
            `FwRfc1918Route${suffix}${cidrIndex}`,
            {
              routeTableId: fwSubnet.routeTable.routeTableId,
              destinationCidrBlock: cidr,
              coreNetworkArn: props.coreNetworkArn,
            },
          );
          fwRoute.addDependency(attachment);
        },
      );

      // CloudWanAttachment RT にフェイルオーバー用タグ (ReplaceRoute がタグ検索で特定)
      const cwRt = (cwSubnet as ec2.Subnet).node.findChild(
        "RouteTable",
      ) as ec2.CfnRouteTable;
      cdk.Tags.of(cwRt).add(
        CLOUDWAN.tagKey.failoverRole,
        FAILOVER_ROLE_INSPECTION_CWAN_RT,
      );
      cdk.Tags.of(cwRt).add(CLOUDWAN.tagKey.failoverRegion, props.regionLabel);
      cdk.Tags.of(cwRt).add(CLOUDWAN.tagKey.failoverAz, azLetter);
      // この RT の AZ 自身の NF エンドポイント ID。ReplaceRoute の向け先の唯一のソース
      // (RT の現在の 0/0 から推測しない。レビュー指摘 2)
      cdk.Tags.of(cwRt).add(CLOUDWAN.tagKey.failoverEndpoint, fwEndpointId);
    });
  }
}
