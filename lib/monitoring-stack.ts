import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import { MONITORING, REGION_CONFIGS, isNfgRegion } from "./config";

export interface MonitoringStackProps extends cdk.StackProps {
  /** SFN ネイティブメトリクスの参照元 (同一リージョン) */
  readonly stateMachine: sfn.StateMachine;
  /** Logs Insights ウィジェットの対象 (同一リージョン) */
  readonly orchestratorLogGroup: logs.LogGroup;
  /** CNE メトリクスの CoreNetwork 次元と Logs Insights フィルターに使用 */
  readonly coreNetworkId: string;
  /** NFG リージョンの unhealthy 継続アラーム ARN (リージョン x AZ。ダッシュボード表示用) */
  readonly probeAlarmArns: string[];
}

/**
 * 運用者向け監視ダッシュボード (us-west-2)。
 *
 * 行構成は「いま対応が必要か → どのリージョン / AZ が悪いか → 何が起きて、いまどの
 * ポリシーか → 仕組みは動いているか → 検査は流れているか」。ラベルと意味は
 * docs/failure-scenarios.md の「実行結果の読み方」に揃える。
 *
 * - カスタムメトリクス (NfgFailover 名前空間) は各スタックのメトリクスフィルターが発行する
 * - 他リージョンのネイティブメトリクスは SEARCH 式 (searchRegion) で拾い、リソース名の
 *   配管を持たない (probe Lambda / NFW / NAT GW の名前は synth 時決定のため)
 * - AWS/Network Manager (Cloud WAN) のメトリクスは us-west-2 のみに集約発行される
 */
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const nfgRegions = REGION_CONFIGS.filter(isNfgRegion).map((r) => r.region);
    const allRegions = REGION_CONFIGS.map((r) => r.region);
    const azLetters = ["a", "b"];

    // probe のカスタムメトリクス (リージョン x AZ の次元付き。発行元リージョンを指定)
    const probeMetric = (
      metricName: string,
      region: string,
      az: string
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: MONITORING.namespace,
        metricName,
        dimensionsMap: { ProbeRegion: region, AzLetter: az },
        statistic: "Sum",
        period: cdk.Duration.minutes(3),
        region,
        label: `${region}/${az}`,
      });
    const probeMetricsAll = (metricName: string): cloudwatch.Metric[] =>
      nfgRegions.flatMap((region) =>
        azLetters.map((az) => probeMetric(metricName, region, az))
      );
    // 6 系列を 1 値に合計する (単一値ウィジェット用)
    const probeSum = (
      metricName: string,
      label: string
    ): cloudwatch.MathExpression => {
      const usingMetrics = Object.fromEntries(
        probeMetricsAll(metricName).map((m, i) => [`m${i}`, m])
      );
      return new cloudwatch.MathExpression({
        expression: `SUM([${Object.keys(usingMetrics).join(",")}])`,
        usingMetrics,
        label,
        period: cdk.Duration.hours(24),
      });
    };

    // オーケストレーターのカスタムメトリクス (次元なし、us-west-2)
    const orchestratorMetric = (
      metricName: string,
      label: string,
      period: cdk.Duration
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: MONITORING.namespace,
        metricName,
        statistic: "Sum",
        period,
        label,
      });

    // 他リージョンのネイティブメトリクスを名前の配管なしで拾う SEARCH 式。
    // 次元セットが公式に判明しているものはスキーマ形式 {Namespace,Dim,...} を使う
    // (公式ドキュメントの実例と同形)。式ごと渡す形にし、名前空間と次元をここで確定する
    const search = (
      expression: string,
      region: string,
      label: string
    ): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        expression,
        searchRegion: region,
        label,
      });
    const lambdaErrorsSearch = (region: string): cloudwatch.MathExpression =>
      search(
        `SEARCH('{AWS/Lambda,FunctionName} MetricName="Errors"', 'Sum', 300)`,
        region,
        region
      );
    // NFW の次元セット (FirewallName / AvailabilityZone / Engine) は公式記載の次元一覧に
    // 基づく組み合わせ。実発行の組み合わせと異なり表示が空になる場合は、実機検証 22 で
    // スキーマ部を外した語検索 (SEARCH('"PassedPackets"', ...)) へ調整する
    const nfwSearch = (
      metricName: string,
      region: string
    ): cloudwatch.MathExpression =>
      search(
        `SEARCH('{AWS/NetworkFirewall,AvailabilityZone,Engine,FirewallName} MetricName="${metricName}"', 'Sum', 300)`,
        region,
        region
      );
    const natSearch = (
      metricName: string,
      region: string,
      label: string
    ): cloudwatch.MathExpression =>
      search(
        `SEARCH('{AWS/NATGateway,NatGatewayId} MetricName="${metricName}"', 'Sum', 300)`,
        region,
        label
      );
    // Scheduler は次元の公式記載が無いため語検索 (メトリクス名の完全一致のみ) で拾う
    const schedulerSearch = (metricName: string): cloudwatch.MathExpression =>
      search(`SEARCH('"${metricName}"', 'Sum', 300)`, this.region, metricName);

    // 行 1: 参考情報 (直近 24h の合計。0 以外なら docs の「実行結果の読み方」へ)
    const day = cdk.Duration.hours(24);
    const singleValue = (
      title: string,
      metric: cloudwatch.IMetric
    ): cloudwatch.SingleValueWidget =>
      new cloudwatch.SingleValueWidget({
        title,
        metrics: [metric],
        width: 4,
        height: 4,
        setPeriodToTimeRange: true,
      });
    const row1 = [
      new cloudwatch.TextWidget({
        markdown:
          "## 参考情報\n0 以外が出たら docs/failure-scenarios.md の「実行結果の読み方」を確認。\n\ntier 2 接続先利用回数はサードパーティの疎通先への接続が発生した回数で、平常時は 0 が正常値",
        width: 4,
        height: 4,
      }),
      singleValue(
        "fail-close 回数 (= 全リージョンの NFG 断)",
        orchestratorMetric("OrchestratorFailClose", "fail-close", day)
      ),
      singleValue(
        "フェイルオーバー完了回数",
        orchestratorMetric("OrchestratorFailoverDone", "FailoverDone", day)
      ),
      singleValue(
        "オーケストラーSFn 実行失敗回数",
        props.stateMachine.metricFailed({ period: day })
      ),
      singleValue(
        "ReplaceRoute 失敗",
        orchestratorMetric(
          "OrchestratorReplaceRouteFailed",
          "ReplaceRouteFailed",
          day
        )
      ),
      singleValue(
        "tier 2 接続先利用回数",
        probeSum("ProbeTier2Contact", "tier2")
      ),
    ];

    // 行 2: どのリージョン / AZ が悪いか
    const row2 = [
      new cloudwatch.GraphWidget({
        title: "unhealthy probe (リージョン x AZ。1 本 = 片AZ、2 本 = 両AZ)",
        left: probeMetricsAll("ProbeUnhealthy"),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "probe Lambda Errors (リージョン別 SEARCH)",
        left: nfgRegions.map((region) => lambdaErrorsSearch(region)),
        width: 12,
        height: 6,
      }),
    ];

    // 行 3: 何が起きて、いまどのポリシーか
    const fiveMin = cdk.Duration.minutes(5);
    const row3 = [
      new cloudwatch.GraphWidget({
        title: "オーケストレーターSFnの挙動 (状態通過カウント)",
        left: [
          orchestratorMetric(
            "OrchestratorPutPolicy",
            "PutPolicy (切替開始)",
            fiveMin
          ),
          orchestratorMetric(
            "OrchestratorFailoverDone",
            "FailoverDone (切替完了)",
            fiveMin
          ),
          orchestratorMetric(
            "OrchestratorSkipAlreadyApplied",
            "SkipAlreadyApplied (適用済み)",
            fiveMin
          ),
          orchestratorMetric("OrchestratorFailClose", "FailClose", fiveMin),
          orchestratorMetric(
            "OrchestratorReplaceRouteDone",
            "ReplaceRouteDone (片AZ切替)",
            fiveMin
          ),
          orchestratorMetric(
            "OrchestratorReplaceRouteFailed",
            "ReplaceRouteFailed",
            fiveMin
          ),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: "オーケストレーたーSFnの実行結果 (直近 20 件)",
        logGroupNames: [props.orchestratorLogGroup.logGroupName],
        queryLines: [
          "fields @timestamp, details.name as state",
          'filter type like /StateEntered/ and details.name in ["FailoverDone", "FailClose", "FailCloseEffective", "PutPolicy", "SkipAlreadyApplied", "NoRegionFailover"]',
          "sort @timestamp desc",
          "limit 20",
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: "直近の PutPolicy",
        logGroupNames: [props.orchestratorLogGroup.logGroupName],
        queryLines: [
          "fields @timestamp, details.parameters",
          'filter type = "TaskScheduled" and details.resource = "putCoreNetworkPolicy"',
          "sort @timestamp desc",
          "limit 5",
        ],
        width: 8,
        height: 6,
      }),
    ];

    // 行 4: 仕組みは動いているか
    const row4 = [
      new cloudwatch.GraphWidget({
        title: "Step Functions (失敗 / タイムアウト)",
        left: [
          props.stateMachine.metricFailed({ period: fiveMin }),
          props.stateMachine.metricTimedOut({ period: fiveMin }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Step Functions 実行時間",
        left: [props.stateMachine.metricTime({ period: fiveMin })],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "EventBridge Scheduler のエラー系 (SEARCH)",
        left: [
          schedulerSearch("TargetErrorCount"),
          schedulerSearch("InvocationDroppedCount"),
          schedulerSearch("InvocationThrottleCount"),
        ],
        width: 8,
        height: 6,
      }),
    ];

    // 行 5a: 検査経路の疎通が正しく行えているか (肯定側のシグナルと劣化の先行指標)
    const probeLatencyMetric = (
      region: string,
      az: string
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: MONITORING.namespace,
        metricName: "ProbeLatencyMs",
        dimensionsMap: { ProbeRegion: region, AzLetter: az },
        statistic: "Average",
        period: cdk.Duration.minutes(3),
        region,
        label: `${region}/${az}`,
      });
    const row5a = [
      new cloudwatch.GraphWidget({
        title:
          "end-to-end 疎通の成立 (3 分ごとに 1 が刻まれ続ければ正常、途切れている場合は = 失敗)",
        left: probeMetricsAll("ProbeHealthy"),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:
          "疎通レイテンシ (悪化している場合はリソースの不調もしくはフェイルオーバーによるレイテンシー増によるもの)",
        left: nfgRegions.flatMap((region) =>
          azLetters.map((az) => probeLatencyMetric(region, az))
        ),
        width: 12,
        height: 6,
      }),
    ];

    // 行 5b: データプレーンの流量
    const row5 = [
      new cloudwatch.GraphWidget({
        title: "NFW PassedPackets (リージョン別 SEARCH)",
        left: nfgRegions.map((region) => nfwSearch("PassedPackets", region)),
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "NFW DroppedPackets (リージョン別 SEARCH)",
        left: nfgRegions.map((region) => nfwSearch("DroppedPackets", region)),
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "NAT GW ErrorPortAllocation / BytesOut (SEARCH)",
        left: nfgRegions.map((region) =>
          natSearch("ErrorPortAllocation", region, `err ${region}`)
        ),
        right: nfgRegions.map((region) =>
          natSearch("BytesOutToDestination", region, `bytes ${region}`)
        ),
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "CNE エッジ別 BytesIn / BytesOut",
        left: allRegions.map(
          (region) =>
            new cloudwatch.Metric({
              namespace: "AWS/Network Manager",
              metricName: "BytesIn",
              dimensionsMap: {
                CoreNetwork: props.coreNetworkId,
                EdgeLocation: region,
              },
              statistic: "Sum",
              period: fiveMin,
              label: `in ${region}`,
            })
        ),
        right: allRegions.map(
          (region) =>
            new cloudwatch.Metric({
              namespace: "AWS/Network Manager",
              metricName: "BytesOut",
              dimensionsMap: {
                CoreNetwork: props.coreNetworkId,
                EdgeLocation: region,
              },
              statistic: "Sum",
              period: fiveMin,
              label: `out ${region}`,
            })
        ),
        width: 6,
        height: 6,
      }),
      new cloudwatch.LogQueryWidget({
        title: "Cloud WAN イベントログ (networkmanagerloggroup)",
        logGroupNames: ["/aws/events/networkmanagerloggroup"],
        queryLines: [
          `filter detail.coreNetworkArn like "${props.coreNetworkId}"`,
          "fields @timestamp, detail.changeType, detail.changeDescription, detail.edgeLocation",
          "sort @timestamp desc",
          "limit 50",
        ],
        width: 24,
        height: 6,
      }),
    ];

    // アラーム (すべてアクションなし。状態表示はダッシュボード先頭行の
    // AlarmStatusWidget で行う)
    const noDataOk = cloudwatch.TreatMissingData.NOT_BREACHING;
    const alarm = (
      id: string,
      metric: cloudwatch.IMetric,
      threshold: number,
      description: string,
      overrides?: Partial<cloudwatch.AlarmProps>
    ): cloudwatch.Alarm =>
      new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: noDataOk,
        alarmDescription: description,
        ...overrides,
      });
    const localAlarms: cloudwatch.IAlarm[] = [
      alarm(
        "FailCloseAlarm",
        orchestratorMetric("OrchestratorFailClose", "fail-close", fiveMin),
        1,
        "全 NFG 断 (fail-close)。検査対象の通信は全断 (最重大)"
      ),
      alarm(
        "SfnFailedAlarm",
        props.stateMachine.metricFailed({ period: fiveMin }),
        1,
        "オーケストレーターの実行失敗"
      ),
      // スケジューラが実行を起こせていないこと自体の検知 (欠測 = 異常とみなす)
      alarm(
        "ExecutionStoppedAlarm",
        props.stateMachine.metricStarted({
          period: cdk.Duration.minutes(15),
          statistic: "Sum",
        }),
        1,
        "15 分間 Step Functions の実行が開始されていない (スケジューラ停止の疑い)",
        {
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        }
      ),
      alarm(
        "ReplaceRouteFailedAlarm",
        orchestratorMetric(
          "OrchestratorReplaceRouteFailed",
          "ReplaceRouteFailed",
          fiveMin
        ),
        1,
        "片AZ切替 (ReplaceRoute) の失敗"
      ),
      alarm(
        "PutPolicyAlarm",
        orchestratorMetric("OrchestratorPutPolicy", "PutPolicy", fiveMin),
        1,
        "リージョンフェイルオーバーのポリシー切替が発生 (発生の周知)"
      ),
      alarm(
        "ConfirmationCanceledAlarm",
        orchestratorMetric(
          "OrchestratorConfirmationCanceled",
          "ConfirmationCanceled",
          cdk.Duration.minutes(30)
        ),
        3,
        "確認再測定による検知取り消しが 30 分で 3 回以上 (断続的な瞬断の疑い)"
      ),
      alarm(
        "ProbeInvokeErrorAlarm",
        orchestratorMetric(
          "OrchestratorProbeInvokeError",
          "ProbeInvokeError",
          cdk.Duration.minutes(15)
        ),
        2,
        "ヘルスチェック Lambda の呼び出し失敗が継続 (ヘルスチェック基盤側異常の疑い)"
      ),
    ];
    const probeAlarms = props.probeAlarmArns.map((arn, i) =>
      cloudwatch.Alarm.fromAlarmArn(this, `ProbeAlarm${i}`, arn)
    );
    const alarmRow = [
      new cloudwatch.AlarmStatusWidget({
        title:
          "アラーム状態 (すべてアクションなし。0 以外の対応は docs の「実行結果の読み方」)",
        alarms: [...localAlarms, ...probeAlarms],
        width: 24,
        height: 4,
      }),
    ];

    new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: MONITORING.dashboardName,
      defaultInterval: cdk.Duration.hours(24),
      widgets: [alarmRow, row1, row2, row3, row4, row5a, row5],
    });
  }
}
