import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as networkmanager from "aws-cdk-lib/aws-networkmanager";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { CLOUDWAN, FAILOVER, MONITORING } from "../config";

export interface HealthCheckVpcProps {
  /** VPC CIDR ブロック */
  readonly vpcCidr: string;
  /** 使用する AZ 名 (config.ts で固定) */
  readonly availabilityZones: readonly [string, string];
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
}

/** 各 AZ のヘルスチェック Lambda を識別する公開情報 (Orchestrator が cross-region で invoke) */
export interface ProbeFunctionRef {
  /** 実 AZ 名 (us-east-1a 等) */
  readonly azName: string;
  readonly functionArn: string;
  /** AWS/Lambda メトリクスの FunctionName ディメンション用 */
  readonly functionName: string;
}

/**
 * HealthCheck VPC (2AZ) - ヘルスチェック専用 (NFG アタッチメント VPC とは別)。
 * 各 AZ の HealthCheck サブネットに Lambda を固定配置し、Cloud WAN 経由で
 * 外部へ疎通検査する。workload セグメントに参加し、send-to で NFG -> Network Firewall -> NAT -> internet を通る。
 */
export class HealthCheckVpc extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly probeFunctions: ProbeFunctionRef[];
  /** リージョンあたり 1 つの unhealthy 継続アラームの ARN (MonitoringStack がダッシュボード表示に使う) */
  public readonly probeAlarmArn: string;

  constructor(scope: Construct, id: string, props: HealthCheckVpcProps) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      availabilityZones: [...props.availabilityZones],
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: "HealthCheck",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        {
          name: "CloudWanAttachment",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    this.vpc = vpc;

    // Lambda の SG: Cloud WAN 経由で外部へ出るため egress 許可
    const lambdaSg = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc,
      description: "for health-check Lambda",
    });

    // Cloud WAN VPC Attachment (両 AZ subnet / workload セグメントへタグ自動割当)
    const cwSubnets = vpc.selectSubnets({
      subnetGroupName: "CloudWanAttachment",
    });
    const attachment = new networkmanager.CfnVpcAttachment(
      this,
      "CloudWanAttachment",
      {
        coreNetworkId: props.coreNetworkId,
        vpcArn: vpc.vpcArn,
        subnetArns: cwSubnets.subnets.map((s) =>
          cdk.Arn.format(
            { service: "ec2", resource: "subnet", resourceName: s.subnetId },
            cdk.Stack.of(this)
          )
        ),
        tags: [{ key: CLOUDWAN.tagKey.segment, value: CLOUDWAN.segment }],
      }
    );

    const code = lambda.Code.fromAsset(
      path.join(__dirname, "..", "lambda", "health-check")
    );

    // 各 AZ の HealthCheck サブネットに Lambda を固定配置
    const probeFunctions: ProbeFunctionRef[] = vpc.availabilityZones.map(
      (azName) => {
        // Construct ID 用のサフィックス。AZ 名の末尾 1 文字を使う
        // (us-east-1a -> A / ap-northeast-1c -> C)
        const azSuffix = azName.slice(-1).toUpperCase();
        const subnet = vpc.selectSubnets({
          subnetGroupName: "HealthCheck",
          availabilityZones: [azName],
        }).subnets[0];

        // ロググループを明示作成し、Lambda に渡す (retention 設定と物理名衝突の回避のため)。
        // logGroup を渡さないと CDK が自動で同名の LogGroup を生成し、物理名が衝突する。
        // Probe 系メトリクスは Lambda が EMF (Embedded Metric Format) で
        // ログに埋め込んで直接発行するため、メトリクスフィルターは不要
        const probeLogGroup = new logs.LogGroup(
          this,
          `ProbeLogGroup${azSuffix}`,
          {
            retention: logs.RetentionDays.ONE_YEAR,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          }
        );

        const fn = new lambda.Function(this, `Probe${azSuffix}`, {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "index.handler",
          code,
          vpc,
          vpcSubnets: { subnets: [subnet] },
          securityGroups: [lambdaSg],
          logGroup: probeLogGroup,
          // ログを JSON にする。Python では print() の出力は素通しされ logging 経由の
          // 出力だけが JSON レコードに包まれるため、EMF (print) はそのまま CloudWatch に
          // 抽出され、進捗ログ (logging) は構造化される。
          // ApplicationLogLevel は logging 経由の進捗ログの絞り込みに効く
          loggingFormat: lambda.LoggingFormat.JSON,
          applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
          systemLogLevelV2: lambda.SystemLogLevel.INFO,
          // 関数タイムアウトは Step Functions 側の待ち時間の内側に置く。
          // 関数がタイムアウトすると EMF に到達せず ProbeUnhealthy が 1 件も発行されない。
          // 検査経路の障害を検知するはずのアラームが沈黙するため、Lambda 自身が
          // 期限前に打ち切って結果を出せるよう、以前の「試行回数から積み上げる式」ではなく
          // Step Functions の待ち時間から逆算する形にした。
          // 旧式は NS 解決 (最大 tier あたり接続タイムアウト x 2) を数えておらず、
          // 余裕が 2.8 秒しか無かったため実機で関数タイムアウトに至った (2026-07-28 確認)。
          // 実際の打ち切りは Lambda 側の DEADLINE_RESERVE_MS が担う
          timeout: cdk.Duration.seconds(FAILOVER.healthCheckTimeoutSeconds - 3),
          environment: {
            PROBE_ENDPOINT_TIERS: JSON.stringify(FAILOVER.probeEndpointTiers),
            PROBE_TIMEOUT_SECONDS: String(FAILOVER.probeTimeoutSeconds),
            PROBE_ATTEMPTS: String(FAILOVER.probeAttempts),
            PROBE_INTERVAL_SECONDS: String(FAILOVER.probeIntervalSeconds),
            AZ: azName,
            CORE_NETWORK_ID: props.coreNetworkId,
            METRIC_NAMESPACE: MONITORING.namespace,
          },
        });
        return {
          azName,
          functionArn: fn.functionArn,
          functionName: fn.functionName,
        };
      }
    );
    this.probeFunctions = probeFunctions;

    // unhealthy の継続 (15 分 = 3 分 x 5 期間) を知らせるアラーム。アクションは付けない (状態はダッシュボードとコンソールで確認する)。
    // アラームはメトリクスと同一リージョンにしか作れないため、発行元リージョン で作成して ARN を
    // MonitoringStack へ渡す。AZ ID は synth 時に分からないため Metrics Insights の
    // SELECT クエリで動的にマッチさせ、GROUP BY AvailabilityZone で AZ ごとに
    // contributor として評価する (リージョンあたり 1 アラームで AZ ごとの異常を検知できる)
    const unhealthyAlarm = new cloudwatch.CfnAlarm(
      this,
      "ProbeUnhealthyAlarm",
      {
        alarmDescription: `検査経路の unhealthy が継続 (${
          cdk.Stack.of(this).region
        })`,
        metrics: [
          {
            id: "q1",
            expression: `SELECT SUM(ProbeUnhealthy) FROM SCHEMA("${
              MONITORING.namespace
            }", EdgeLocation, AvailabilityZone, CoreNetwork) WHERE EdgeLocation = '${
              cdk.Stack.of(this).region
            }' AND CoreNetwork = '${
              props.coreNetworkId
            }' GROUP BY AvailabilityZone ORDER BY SUM() DESC`,
            period: 180,
            returnData: true,
          },
        ],
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        // 1 サイクル (3 分) の unhealthy 1 回で breach とし、5 期間 = 15 分の継続で
        // ALARM にする。metricValue は 1 ログ行あたり 1 のため閾値は 1 が正しい
        // (5 にすると 1 期間の Sum が最大 2 程度で到達せず、永久に発火しない)
        threshold: 1,
        evaluationPeriods: 5,
        treatMissingData: "notBreaching",
      }
    );
    this.probeAlarmArn = unhealthyAlarm.attrArn;

    // 各 AZ の HealthCheck RT: 全トラフィックを Core Network へ (send-to で NFG 経由 -> 外部)
    const hcSubnets = vpc.selectSubnets({ subnetGroupName: "HealthCheck" });
    hcSubnets.subnets.forEach((subnet, index) => {
      const route = new ec2.CfnRoute(
        this,
        `HcSubnetDefaultRoute${String.fromCharCode(65 + index)}`,
        {
          routeTableId: subnet.routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          coreNetworkArn: props.coreNetworkArn,
        }
      );
      route.addDependency(attachment);
    });
  }
}
