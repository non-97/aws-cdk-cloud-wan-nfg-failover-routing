import * as cdk from "aws-cdk-lib/core";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import { MONITORING, REGION_CONFIGS, isNfgRegion } from "./config";
import { ProbeTarget } from "./orchestrator-stack";
import { NatGatewayRef } from "./constructs";

export interface MonitoringStackProps extends cdk.StackProps {
  /** SFN ネイティブメトリクスの参照元 (同一リージョン) */
  readonly stateMachine: sfn.StateMachine;
  /** Logs Insights ウィジェットの対象 (同一リージョン) */
  readonly orchestratorLogGroup: logs.LogGroup;
  /** CNE メトリクスの CoreNetwork ディメンションと Logs Insights フィルターに使用 */
  readonly coreNetworkId: string;
  /** NFG リージョンの unhealthy 継続アラーム ARN (リージョンあたり 1 つ。ダッシュボード表示用) */
  readonly probeAlarmArns: string[];
  /** probe Lambda の Errors メトリクス用 */
  readonly probeTargets: readonly ProbeTarget[];
  /** NFW メトリクスの FirewallName ディメンション。キーはリージョン */
  readonly firewallNames: Readonly<Record<string, string>>;
  /** NAT ゲートウェイメトリクスの NatGatewayId ディメンションとラベル用の AZ 名。キーはリージョン */
  readonly natGateways: Readonly<Record<string, readonly NatGatewayRef[]>>;
}

/**
 * 運用者向け監視ダッシュボード (us-west-2)。
 *
 * 行構成は「いま対応が必要か → どのリージョン / AZ が悪いか → 何が起きて、いまどの
 * ポリシーか → 仕組みは動いているか → 検査は流れているか」。ラベルと意味は
 * docs/failure-scenarios.md の「実行結果の読み方」に揃える。
 *
 * - カスタムメトリクス (NfgFailover 名前空間) は各スタックのメトリクスフィルターが発行する
 * - 他リージョンのネイティブメトリクスは、自プロジェクトのリソースだけを拾うようリソース
 *   識別子で絞り込む。Firewall 名は synth 時に確定するため素の文字列で渡し、Lambda 関数名と
 *   NAT ゲートウェイ ID はデプロイ時決定のため crossRegionReferences 経由で渡す
 * - AWS/Network Manager (Cloud WAN) のメトリクスは us-west-2 のみに集約発行される
 */
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const nfgRegions = REGION_CONFIGS.filter(isNfgRegion).map((r) => r.region);
    const allRegions = REGION_CONFIGS.map((r) => r.region);

    // 他リージョンのネイティブメトリクスを名前の配管なしで拾う SEARCH 式。
    // ディメンションセットが公式に判明しているものはスキーマ形式 {Namespace,Dim,...} を使う
    // (公式ドキュメントの実例と同形)。式ごと渡す形にし、名前空間とディメンションをここで確定する
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

    // probe のカスタムメトリクス (リージョン x CoreNetwork のディメンション付き。発行元リージョンを指定)。
    // AZ ID は synth 時に分からない (Lambda メタデータエンドポイントで実行時取得のため) ので
    // SEARCH 式で動的にマッチさせる。EdgeLocation / CoreNetwork で絞り込むだけで
    // AvailabilityZone ごとの系列は SEARCH が自動展開する
    // グラフ用 SEARCH の凡例は動的ラベルにする (region の静的文字列だと同一リージョンの
    // 2 AZ が同じ凡例名になるため。ProbeUnhealthy / ProbeHealthy / ProbeLatencyMs は
    // 全リージョン共通で EdgeLocation / AvailabilityZone のディメンションを持つ)
    const dynamicAzLabel =
      "${PROP('Dim.EdgeLocation')}/${PROP('Dim.AvailabilityZone')}";
    const probeSearch = (
      metricName: string,
      region: string
    ): cloudwatch.MathExpression =>
      search(
        `SEARCH('{${MONITORING.namespace},EdgeLocation,AvailabilityZone,CoreNetwork} MetricName="${metricName}" EdgeLocation="${region}" CoreNetwork="${props.coreNetworkId}"', 'Sum', 180)`,
        region,
        dynamicAzLabel
      );
    const probeSearchAll = (metricName: string): cloudwatch.MathExpression[] =>
      nfgRegions.map((region) => probeSearch(metricName, region));
    // SEARCH 式群を 1 値に合計する (単一値ウィジェット用)。
    // 24h 集計の MathExpression 本体の period (86400) と、内部で使う SEARCH 式の
    // period 引数を揃える必要があるため、グラフ用 probeSearch (period 180) とは
    // 別に、probeSum 専用の SEARCH を定義する
    const probeSum = (
      metricName: string,
      label: string
    ): cloudwatch.MathExpression => {
      const usingMetrics = Object.fromEntries(
        nfgRegions.map((region, i) => [
          `m${i}`,
          search(
            `SEARCH('{${MONITORING.namespace},EdgeLocation,AvailabilityZone,CoreNetwork} MetricName="${metricName}" EdgeLocation="${region}" CoreNetwork="${props.coreNetworkId}"', 'Sum', 86400)`,
            region,
            region
          ),
        ])
      );
      return new cloudwatch.MathExpression({
        expression: `SUM([${Object.keys(usingMetrics).join(",")}])`,
        usingMetrics,
        label,
        period: cdk.Duration.hours(24),
      });
    };

    // オーケストレーターのカスタムメトリクス (CoreNetwork ディメンション付き、us-west-2)
    const orchestratorMetric = (
      metricName: string,
      label: string,
      period: cdk.Duration
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: MONITORING.namespace,
        metricName,
        dimensionsMap: { CoreNetwork: props.coreNetworkId },
        statistic: "Sum",
        period,
        label,
      });

    // NFW のディメンションセット (FirewallName / AvailabilityZone / Engine) は公式記載のディメンション一覧に
    // 基づく組み合わせ。実発行の組み合わせと異なり表示が空になる場合は、実機検証 22 で
    // スキーマ部を外した語検索 (SEARCH('"PassedPackets"', ...)) へ調整する
    const nfwSearch = (
      metricName: string,
      region: string
    ): cloudwatch.MathExpression =>
      search(
        `SEARCH('{AWS/NetworkFirewall,AvailabilityZone,Engine,FirewallName} MetricName="${metricName}" FirewallName="${props.firewallNames[region]}"', 'Sum', 300)`,
        region,
        region
      );
    // NAT ゲートウェイは AZ ごとに 1 台あり、片 AZ だけの枯渇や偏りを見分けたいため
    // リージョンで合算せず 1 台ずつ系列を分ける
    // labelPrefix は左右の軸で同じ AZ 名が重複するのを避けるためにつける
    // statistic は AWS のメトリクス一覧の「most useful statistic」に合わせる。
    // ActiveConnectionCount は同時接続数の瞬時値のため Max、それ以外は Sum
    const natMetrics = (
      metricName: string,
      labelPrefix: string,
      statistic = "Sum"
    ): cloudwatch.Metric[] =>
      nfgRegions.flatMap((region) =>
        (props.natGateways[region] ?? []).map(
          (nat) =>
            new cloudwatch.Metric({
              namespace: "AWS/NATGateway",
              metricName,
              dimensionsMap: { NatGatewayId: nat.natGatewayId },
              region,
              statistic,
              period: cdk.Duration.minutes(5),
              label: `${labelPrefix} ${nat.azName}`,
            })
        )
      );
    // Scheduler は ScheduleGroup ディメンションのみで絞れるため、この仕組み専用のグループを作って分離している
    const schedulerSearch = (metricName: string): cloudwatch.MathExpression =>
      search(
        `SEARCH('{AWS/Scheduler,ScheduleGroup} MetricName="${metricName}" ScheduleGroup="${MONITORING.scheduleGroupName}"', 'Sum', 300)`,
        this.region,
        metricName
      );

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
        "fail-close 回数 (= 全リージョンの NFG アタッチメント断)",
        orchestratorMetric("OrchestratorFailClose", "fail-close", day)
      ),
      singleValue(
        "フェイルオーバー完了回数",
        orchestratorMetric("OrchestratorFailoverDone", "FailoverDone", day)
      ),
      singleValue(
        "オーケストレーターSFn 実行失敗回数",
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
        title: "unhealthy probe (AZ別)",
        left: probeSearchAll("ProbeUnhealthy"),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "probe Lambda Errors (AZ 別)",
        left: props.probeTargets.map(
          (t) =>
            new cloudwatch.Metric({
              namespace: "AWS/Lambda",
              metricName: "Errors",
              dimensionsMap: { FunctionName: t.functionName },
              region: t.region,
              statistic: "Sum",
              period: cdk.Duration.minutes(5),
              label: t.azName,
            })
        ),
        width: 12,
        height: 6,
      }),
    ];

    // 行 3: 何が起きて、いまどのポリシーか
    const fiveMin = cdk.Duration.minutes(5);
    const row3 = [
      new cloudwatch.GraphWidget({
        title: "オーケストレーターSFnによる操作",
        left: [
          orchestratorMetric(
            "OrchestratorPutPolicy",
            "PutPolicy (リージョンフェイルオーバー切替開始)",
            fiveMin
          ),
          orchestratorMetric(
            "OrchestratorFailoverDone",
            "FailoverDone (リージョンフェイルオーバー切替完了)",
            fiveMin
          ),
          orchestratorMetric(
            "OrchestratorSkipAlreadyApplied",
            "SkipAlreadyApplied (Core Network Policy適用済み)",
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
        title: "オーケストレーターSFnの実行結果 (直近 20 件)",
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

    // 行 5a: 検査経路の疎通が正しく行えているか (肯定側のシグナルと劣化の先行指標)。
    // AZ ID は synth 時に分からないため SEARCH 式で動的にマッチさせる (probeSearch と同形)
    const probeLatencySearch = (region: string): cloudwatch.MathExpression =>
      search(
        `SEARCH('{${MONITORING.namespace},EdgeLocation,AvailabilityZone,CoreNetwork} MetricName="ProbeLatencyMs" EdgeLocation="${region}" CoreNetwork="${props.coreNetworkId}"', 'Average', 180)`,
        region,
        dynamicAzLabel
      );
    const row5a = [
      new cloudwatch.GraphWidget({
        title:
          "インターネットへの疎通結果 (3 分ごとに 1 が刻まれ続ければ正常、途切れている場合は失敗)",
        left: probeSearchAll("ProbeHealthy"),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:
          "疎通レイテンシ (悪化している場合はリソースの不調もしくはフェイルオーバーによるレイテンシー増によるもの)",
        left: nfgRegions.map((region) => probeLatencySearch(region)),
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
        height: 10,
      }),
      new cloudwatch.GraphWidget({
        title: "NFW DroppedPackets (リージョン別 SEARCH)",
        left: nfgRegions.map((region) => nfwSearch("DroppedPackets", region)),
        width: 6,
        height: 10,
      }),
      new cloudwatch.GraphWidget({
        title: "NAT Gateway BytesOut (NAT ゲートウェイ別)",
        left: natMetrics("BytesOutToDestination", "bytes"),
        width: 6,
        height: 10,
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
        height: 10,
      }),
    ];

    // 行 5c: NAT ゲートウェイの詳細。ポート枯渇の予兆 (同時接続数) と、
    // NAT ゲートウェイ自身の異常 (ドロップ) を AZ ごとに切り分けるための行
    const row5c = [
      new cloudwatch.GraphWidget({
        title: "NAT Gateway 同時接続数 / 接続確立数 (NAT ゲートウェイ別)",
        // 同時接続数は瞬時値のため Max。ErrorPortAllocation が出る手前の予兆になる
        left: natMetrics("ActiveConnectionCount", "active", "Max"),
        right: natMetrics("ConnectionEstablishedCount", "established"),
        width: 12,
        height: 10,
      }),
      new cloudwatch.GraphWidget({
        title:
          "NAT Gateway エラー ErrorPortAllocation / PacketsDropCount (NAT ゲートウェイ別)",
        // どちらも平常時は 0 の異常シグナルのため同じパネルに置く。
        // ErrorPortAllocation はポート枯渇、PacketsDropCount は NAT ゲートウェイ自身の異常で、
        // 後者が総パケット数の 0.01% を超える場合は VPC サービス側の問題を疑う。
        // 一方が突出したときにもう一方が潰れないよう軸を左右に分ける
        left: natMetrics("ErrorPortAllocation", "err"),
        right: natMetrics("PacketsDropCount", "drop"),
        width: 12,
        height: 10,
      }),
    ];

    // 行 6: Cloud WAN のイベントログ (ポリシー適用やアタッチメントの状態変化の履歴)
    const row6 = [
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
      widgets: [alarmRow, row1, row2, row3, row4, row5a, row5, row5c, row6],
    });
  }
}
