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
  /** 使用する AZ 名 (順序が論理 AZ 識別子 a / b に対応。config.ts で固定) */
  readonly availabilityZones: readonly [string, string];
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN */
  readonly coreNetworkArn: string;
}

/** 各 AZ のヘルスチェック Lambda を識別する公開情報 (Orchestrator が cross-region で invoke) */
export interface ProbeFunctionRef {
  /** 論理 AZ 識別子 (a / b) */
  readonly azLetter: string;
  /** Lambda の関数 ARN */
  readonly functionArn: string;
  /** その AZ の unhealthy 継続アラームの ARN */
  readonly alarmArn: string;
}

/**
 * HealthCheck VPC (2AZ) - ヘルスチェック専用 (NFG アタッチメント VPC とは別)。
 * 各 AZ の HealthCheck サブネットに Lambda を固定配置し (同 AZ pinning)、Cloud WAN 経由で
 * 外部へ疎通検査する。workload セグメントに参加し、send-to で NFG -> NAT -> internet を通る。
 */
export class HealthCheckVpc extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly probeFunctions: ProbeFunctionRef[];
  /** AZ ごとの unhealthy 継続アラームの ARN (MonitoringStack がダッシュボード表示に使う) */
  public readonly probeAlarmArns: string[];

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
        tags: [{ key: CLOUDWAN.tagKey.segment, value: CLOUDWAN.segment }],
      },
    );

    const code = lambda.Code.fromAsset(
      path.join(__dirname, "..", "lambda", "health-check"),
    );

    // 各 AZ の HealthCheck サブネットに Lambda を固定配置 (同 AZ pinning)
    const probeFunctions: ProbeFunctionRef[] = vpc.availabilityZones.map(
      (az, index) => {
        const azLetter = String.fromCharCode(97 + index); // 0 -> 'a', 1 -> 'b'
        const subnet = vpc.selectSubnets({
          subnetGroupName: "HealthCheck",
          availabilityZones: [az],
        }).subnets[0];

        // メトリクスフィルターを張るためロググループを明示作成し、Lambda に渡す。
        // logGroup を渡さないと CDK が自動で同名の LogGroup を生成し、物理名が衝突する。
        // 判定ログは 1 行 JSON のため、JSON パターンで healthy / tiersProbed を抽出し、
        // region / azLetter を次元としてカスタムメトリクスへ発行する
        const probeLogGroup = new logs.LogGroup(
          this,
          `ProbeLogGroup${azLetter.toUpperCase()}`,
          {
            retention: logs.RetentionDays.ONE_YEAR,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          },
        );

        const fn = new lambda.Function(this, `Probe${azLetter.toUpperCase()}`, {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "index.handler",
          code,
          vpc,
          vpcSubnets: { subnets: [subnet] },
          securityGroups: [lambdaSg],
          logGroup: probeLogGroup,
          // tier を順に試すため最悪ケースは tier 数 x 試行回数 x (接続タイムアウト + 間隔)。
          // 現行値で 25 秒となり、Step Functions 側の healthCheckTimeoutSeconds (30 秒) の
          // 内側。NS lookup の遅延まで重なる絶対最悪は関数タイムアウトで打ち切られ得るが、
          // Step Functions 側で unhealthy に正規化される (fail-close 方向で安全)
          timeout: cdk.Duration.seconds(
            Math.ceil(
              FAILOVER.probeEndpointTiers.length *
                FAILOVER.probeAttempts *
                (FAILOVER.probeTimeoutSeconds + FAILOVER.probeIntervalSeconds),
            ) + 5,
          ),
          environment: {
            PROBE_ENDPOINT_TIERS: JSON.stringify(FAILOVER.probeEndpointTiers),
            PROBE_TIMEOUT_SECONDS: String(FAILOVER.probeTimeoutSeconds),
            PROBE_ATTEMPTS: String(FAILOVER.probeAttempts),
            PROBE_INTERVAL_SECONDS: String(FAILOVER.probeIntervalSeconds),
            AZ_LETTER: azLetter,
          },
        });
        new logs.MetricFilter(this, `ProbeUnhealthy${azLetter.toUpperCase()}`, {
          logGroup: probeLogGroup,
          metricNamespace: MONITORING.namespace,
          metricName: "ProbeUnhealthy",
          filterPattern: logs.FilterPattern.literal("{ $.healthy IS FALSE }"),
          metricValue: "1",
          dimensions: { ProbeRegion: "$.region", AzLetter: "$.azLetter" },
        });
        new logs.MetricFilter(this, `ProbeTier2${azLetter.toUpperCase()}`, {
          logGroup: probeLogGroup,
          metricNamespace: MONITORING.namespace,
          metricName: "ProbeTier2Contact",
          filterPattern: logs.FilterPattern.literal("{ $.tiersProbed >= 2 }"),
          metricValue: "1",
          dimensions: { ProbeRegion: "$.region", AzLetter: "$.azLetter" },
        });
        // 疎通の成立 (肯定側のシグナル)。3 分ごとに 1 が刻まれ続ければ、その AZ の
        // 検査経路の end-to-end 疎通が正しく行えている
        new logs.MetricFilter(this, `ProbeHealthy${azLetter.toUpperCase()}`, {
          logGroup: probeLogGroup,
          metricNamespace: MONITORING.namespace,
          metricName: "ProbeHealthy",
          filterPattern: logs.FilterPattern.literal("{ $.healthy IS TRUE }"),
          metricValue: "1",
          dimensions: { ProbeRegion: "$.region", AzLetter: "$.azLetter" },
        });
        // 疎通レイテンシ (判定確定までの ms)。劣化の先行指標
        new logs.MetricFilter(this, `ProbeLatency${azLetter.toUpperCase()}`, {
          logGroup: probeLogGroup,
          metricNamespace: MONITORING.namespace,
          metricName: "ProbeLatencyMs",
          filterPattern: logs.FilterPattern.literal("{ $.latencyMs >= 0 }"),
          metricValue: "$.latencyMs",
          dimensions: { ProbeRegion: "$.region", AzLetter: "$.azLetter" },
        });
        // unhealthy の継続 (15 分 = 3 分 x 5 期間) を知らせるアラーム。アクションは
        // 付けない (状態はダッシュボードとコンソールで確認する)。アラームはメトリクスと
        // 同一リージョンにしか作れないため、ここ (発行元リージョン) で作成して ARN を
        // MonitoringStack へ渡す
        const unhealthyAlarm = new cloudwatch.Alarm(
          this,
          `ProbeUnhealthyAlarm${azLetter.toUpperCase()}`,
          {
            metric: new cloudwatch.Metric({
              namespace: MONITORING.namespace,
              metricName: "ProbeUnhealthy",
              dimensionsMap: {
                ProbeRegion: cdk.Stack.of(this).region,
                AzLetter: azLetter,
              },
              statistic: "Sum",
              period: cdk.Duration.minutes(3),
            }),
            threshold: 1,
            comparisonOperator:
              cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            evaluationPeriods: 5,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription: `検査経路の unhealthy が 15 分継続 (AZ ${azLetter})`,
          },
        );
        return { azLetter, functionArn: fn.functionArn, alarmArn: unhealthyAlarm.alarmArn };
      },
    );
    this.probeFunctions = probeFunctions;
    this.probeAlarmArns = probeFunctions.map((p) => p.alarmArn);

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
        },
      );
      route.addDependency(attachment);
    });
  }
}
