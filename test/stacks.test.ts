import { App } from "aws-cdk-lib/core";
import { Template, Match } from "aws-cdk-lib/assertions";
import { FAILOVER, REGION_CONFIGS, isNfgRegion } from "../lib/config";
import { CoreStack } from "../lib/core-stack";
import { RegionStack } from "../lib/region-stack";
import { OrchestratorStack, ProbeTarget } from "../lib/orchestrator-stack";
import { MonitoringStack } from "../lib/monitoring-stack";

/**
 * バンドル処理をスキップする定型。本プロジェクトの Lambda は素の Code.fromAsset
 * (Python ディレクトリ) のため実質 no-op だが、バンドルを伴う Lambda を将来
 * 追加してもテストが遅くならないよう維持する。
 */
const newApp = () => new App({ context: { "aws:cdk:bundling-stacks": [] } });

const CORE_ID = "core-network-0000";
const CORE_ARN = "arn:aws:networkmanager::123456789012:core-network/core-network-0000";

/** AZ 環境変数を持つ = health-check Lambda の判定基準 */
const healthCheckLambda = {
  Environment: { Variables: Match.objectLike({ AZ: Match.anyValue() }) },
};

describe("CoreStack", () => {
  const stack = new CoreStack(newApp(), "Core", {});
  const t = Template.fromStack(stack);

  test("snapshot", () => expect(t.toJSON()).toMatchSnapshot());

  test("CoreNetwork が 1 つ", () => {
    t.resourceCountIs("AWS::NetworkManager::CoreNetwork", 1);
    t.resourceCountIs("AWS::NetworkManager::GlobalNetwork", 1);
  });
});

describe("RegionStack (NFG あり: us-east-1)", () => {
  const cfg = REGION_CONFIGS.find((r) => r.region === "us-east-1")!;
  const stack = new RegionStack(newApp(), "RegionUsEast1", {
    regionConfig: cfg,
    coreNetworkId: CORE_ID,
    coreNetworkArn: CORE_ARN,
  });
  const t = Template.fromStack(stack);

  test("snapshot", () => expect(t.toJSON()).toMatchSnapshot());

  test("Network Firewall が 1 つ", () => {
    t.resourceCountIs("AWS::NetworkFirewall::Firewall", 1);
  });

  test("NAT Gateway が各 AZ に 1 つずつ (計 2)", () => {
    t.resourceCountIs("AWS::EC2::NatGateway", 2);
  });

  test("Workload EC2 が各 VPC x 各 AZ に 1 台ずつ (2 VPC x 2 AZ = 4)", () => {
    t.resourceCountIs("AWS::EC2::Instance", 4);
  });

  test("health-check Lambda が各 AZ に 1 つずつ (計 2)", () => {
    t.resourcePropertiesCountIs(
      "AWS::Lambda::Function",
      healthCheckLambda,
      2,
    );
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ AZ: "us-east-1a" }) },
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ AZ: "us-east-1b" }) },
    });
  });

  test("probe Lambda は tier 化された疎通先 (AWS 管理優先) と JSON ログ設定を持つ", () => {
    const fns = Object.values(t.findResources("AWS::Lambda::Function")).filter(
      (f: any) => f.Properties?.Environment?.Variables?.PROBE_ENDPOINT_TIERS,
    ) as any[];
    expect(fns).toHaveLength(2);
    const tiers = JSON.parse(
      fns[0].Properties.Environment.Variables.PROBE_ENDPOINT_TIERS,
    );
    expect(tiers).toEqual([
      [
        { nsOfZone: "amazonaws.com", port: 53 },
        { host: "checkip.amazonaws.com", port: 443 },
      ],
      [
        { host: "1.1.1.1", port: 53 },
        { host: "8.8.8.8", port: 53 },
      ],
    ]);
    // 関数タイムアウトは Step Functions 側の待ち時間 (30 秒) の内側。
    // 関数がタイムアウトすると EMF に到達せず ProbeUnhealthy が発行されないため、
    // Lambda 自身が期限前に打ち切って結果を出せる余地を残す
    expect(fns[0].Properties.Timeout).toBe(FAILOVER.healthCheckTimeoutSeconds - 3);
    // ログは JSON 形式。Python では print() (EMF) は素通しされ logging だけが JSON に包まれる
    expect(fns[0].Properties.LoggingConfig.LogFormat).toBe("JSON");
    expect(fns[0].Properties.LoggingConfig.ApplicationLogLevel).toBe("INFO");
  });

  test("probe Lambda は EMF 発行に必要な環境変数を持つ (メトリクスフィルターは使わない)", () => {
    // Probe 系メトリクスは Lambda が EMF で直接発行するため MetricFilter は不要
    t.resourceCountIs("AWS::Logs::MetricFilter", 0);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CORE_NETWORK_ID: Match.anyValue(),
          METRIC_NAMESPACE: "NfgFailover",
        }),
      },
    });
  });

  test("Inspection の Cloud WAN アタッチメント RT (2 AZ) にフェイルオーバータグが付く", () => {
    // hasResourceProperties の arrayWith は Tags 配列で取りこぼすため findResources で検証する
    const rts = t.findResources("AWS::EC2::RouteTable");
    type Tag = { Key: string; Value: string };
    const tagged = Object.values(rts).filter((r: any) =>
      ((r.Properties?.Tags ?? []) as Tag[]).some(
        (tg) => tg.Key === "failover-role" && tg.Value === "inspection-cwan-rt",
      ),
    );
    // 2 AZ 分の RT
    expect(tagged).toHaveLength(2);
    // 各 RT は region タグ (us-east-1) と自 AZ の NF endpoint タグ (ReplaceRoute の
    // 向け先の唯一のソース) を持ち、az タグは実 AZ 名で揃う
    const azValues = (tagged as any[]).map((r) => {
      const tags = (r.Properties.Tags ?? []) as Tag[];
      expect(
        tags.some((tg) => tg.Key === "failover-region" && tg.Value === "us-east-1"),
      ).toBe(true);
      expect(tags.some((tg) => tg.Key === "failover-endpoint")).toBe(true);
      return tags.find((tg) => tg.Key === "failover-az")?.Value;
    });
    expect(new Set(azValues)).toEqual(new Set(["us-east-1a", "us-east-1b"]));
  });

  test("LogGroup は 1 年保持 + RETAIN (監査要件を想定)", () => {
    // NFW ALERT / FLOW + ヘルスチェック Lambda x2 AZ の計 4 つ
    const logGroups = t.findResources("AWS::Logs::LogGroup");
    const entries = Object.values(logGroups) as any[];
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const lg of entries) {
      expect(lg.Properties.RetentionInDays).toBe(365);
      expect(lg.DeletionPolicy).toBe("Retain");
    }
  });

  test("VPC アタッチメントが 4 つ (Workload x2 / Inspection / HealthCheck)", () => {
    t.resourceCountIs("AWS::NetworkManager::VpcAttachment", 4);
  });

  test("Public / Firewall RT の内部戻りルートが RFC1918 全帯をカバー (各 2 AZ x 3 CIDR)", () => {
    const rfc1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
    const routes = Object.values(t.findResources("AWS::EC2::Route"));
    // Public RT: NF endpoint 向け (VpcEndpointId 指定 + RFC1918 宛)。
    // CwSubnetDefaultRoute は 0.0.0.0/0 宛のため CIDR フィルタで除外される
    const toNfEndpoint = routes.filter(
      (r: any) =>
        r.Properties.VpcEndpointId !== undefined &&
        rfc1918.includes(r.Properties.DestinationCidrBlock),
    );
    expect(toNfEndpoint).toHaveLength(6);
    // Firewall RT: Core Network 向け (CoreNetworkArn 指定 + RFC1918 宛)。
    // Workload / HealthCheck の Core Network 向けは 0.0.0.0/0 宛のため除外される
    const toCoreNetwork = routes.filter(
      (r: any) =>
        r.Properties.CoreNetworkArn !== undefined &&
        rfc1918.includes(r.Properties.DestinationCidrBlock),
    );
    expect(toCoreNetwork).toHaveLength(6);
  });

  test("unhealthy 継続アラームがリージョンあたり 1 個 (Metrics Insights, アクションなし)", () => {
    t.resourceCountIs("AWS::CloudWatch::Alarm", 1);
  });

  test("unhealthy アラームは閾値 1 x 5 期間 (15 分継続) で、AZ ごとに評価する", () => {
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")) as any[];
    expect(alarms).toHaveLength(1);
    const props = alarms[0].Properties;
    // metricValue は 1 ログ行あたり 1 のため、閾値 1 x 5 期間で 15 分継続を表す。
    // 閾値を 2 以上にすると 1 期間 (3 分) の Sum が最大 2 程度で到達しなくなる
    expect(props.Threshold).toBe(1);
    expect(props.EvaluationPeriods).toBe(5);
    expect(props.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(props.TreatMissingData).toBe("notBreaching");
    expect(props.AlarmActions).toBeUndefined();
    // Expression は coreNetworkId のトークンを含むため JSON 文字列化して検証する
    const query = JSON.stringify(props.Metrics[0].Expression);
    expect(props.Metrics[0].Period).toBe(180);
    expect(query).toContain("SELECT SUM(ProbeUnhealthy)");
    expect(query).toContain("GROUP BY AvailabilityZone");
    // multi-time-series アラームは GROUP BY と ORDER BY の両方が必須
    expect(query).toContain("ORDER BY SUM() DESC");
  });
});

describe("RegionStack (NFG なし: us-west-2)", () => {
  const cfg = REGION_CONFIGS.find((r) => r.region === "us-west-2")!;
  const stack = new RegionStack(newApp(), "RegionUsWest2", {
    regionConfig: cfg,
    coreNetworkId: CORE_ID,
    coreNetworkArn: CORE_ARN,
  });
  const t = Template.fromStack(stack);

  test("snapshot", () => expect(t.toJSON()).toMatchSnapshot());

  test("Network Firewall / NAT Gateway は無い", () => {
    t.resourceCountIs("AWS::NetworkFirewall::Firewall", 0);
    t.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  test("health-check Lambda は無い", () => {
    t.resourcePropertiesCountIs("AWS::Lambda::Function", healthCheckLambda, 0);
  });

  test("Workload の VPC アタッチメントのみ (2 つ)", () => {
    t.resourceCountIs("AWS::NetworkManager::VpcAttachment", 2);
  });
});

describe("OrchestratorStack", () => {
  const probeTargets: ProbeTarget[] = REGION_CONFIGS.filter(
    isNfgRegion,
  ).flatMap((r) =>
    r.availabilityZones.map((azName) => ({
      region: r.region,
      azName,
      functionArn: `arn:aws:lambda:${r.region}:123456789012:function:probe-${azName}`,
      functionName: `probe-${azName}`,
    })),
  );
  const stack = new OrchestratorStack(newApp(), "Orchestrator", {
    coreNetworkId: CORE_ID,
    coreNetworkArn: CORE_ARN,
    probeTargets,
  });
  const t = Template.fromStack(stack);

  test("snapshot", () => expect(t.toJSON()).toMatchSnapshot());

  test("State Machine が 1 つ", () => {
    t.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
  });

  test("実行ログのメトリクスフィルター 8 つ (状態通過をカスタムメトリクス化)", () => {
    t.resourceCountIs("AWS::Logs::MetricFilter", 8);
  });

  test("EventBridge Scheduler が 1 つ (3 分間隔、無効状態でデプロイ)", () => {
    t.resourceCountIs("AWS::Scheduler::Schedule", 1);
    t.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(3 minutes)",
      State: "DISABLED",
      Name: "nfg-failover-orchestrator",
      GroupName: "nfg-failover",
    });
  });

  test("スケジュールは専用のスケジュールグループに置く (ダッシュボードの絞り込み用)", () => {
    t.resourceCountIs("AWS::Scheduler::ScheduleGroup", 1);
    t.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
      Name: "nfg-failover",
    });
  });

  test("cross-region SDK proxy Lambda は Singleton で 1 つ", () => {
    t.resourceCountIs("AWS::Lambda::Function", 1);
  });

  test("State Machine の実行ログが有効", () => {
    t.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      LoggingConfiguration: Match.objectLike({ Level: "ALL" }),
    });
  });

  test("ASL に冪等性チェック (AlreadyApplied / SkipAlreadyApplied) が含まれる", () => {
    const sm = Object.values(
      t.findResources("AWS::StepFunctions::StateMachine"),
    )[0] as any;
    // DefinitionString は Fn::Join。文字列パートのみ連結して検証する。
    // "AlreadyApplied" は引用符込みで検証する。引用符なしだと
    // SkipAlreadyApplied の部分文字列にマッチして偽陽性になる
    const defText = sm.Properties.DefinitionString["Fn::Join"][1]
      .filter((part: unknown) => typeof part === "string")
      .join("");
    expect(defText).toContain('"AlreadyApplied"');
    expect(defText).toContain('"SkipAlreadyApplied"');
    expect(defText).toContain("with-edge-overrides");
    // change set の生成完了待ちと、実行ポーリング上限到達時の正常終了
    expect(defText).toContain('"GenerationReady"');
    expect(defText).toContain('"ChangeSetStillExecuting"');
    // ReplaceRoute 失敗の Catch (Parallel 道連れ防止) と PutPolicy の競合スキップ
    expect(defText).toContain('"ReplaceRouteFailed-us-east-1"');
    expect(defText).toContain('"PutPolicyConflict"');
    // ReplaceRoute 成功の着地点 (可観測化。レビュー指摘 3)
    expect(defText).toContain('"ReplaceRouteDone-us-east-1"');
    // AZ ごとの静的展開 (failedAzs の各 AZ を個別に付け替える)
    expect(defText).toContain('"NeedReplaceAz-us-east-1a"');
    expect(defText).toContain('"ReplaceRt-us-east-1a"');
    expect(defText).toContain("failedAzs");
    // 確認再測定による検知取り消しの可視化
    expect(defText).toContain('"ConfirmationCanceled"');
    // 適用済み判定はアクション単位 ($filter + 無名関数) で比較する
    expect(defText).toContain("$filter($toActions");
    // 確認再測定 (レビュー指摘 4): 1 回目で異常が出たときだけ 2 回目の probe を行う
    expect(defText).toContain('"NeedConfirm"');
    expect(defText).toContain('"WaitConfirm"');
    expect(defText).toContain('"HealthCheckConfirm-us-east-1a"');
    expect(defText).toContain('"AggregateConfirm"');
  });

  test("ASL に sticky avoid (MergeLiveAvoid / EffectiveFailClose) が含まれる", () => {
    const sm = Object.values(
      t.findResources("AWS::StepFunctions::StateMachine"),
    )[0] as any;
    const defText = sm.Properties.DefinitionString["Fn::Join"][1]
      .filter((part: unknown) => typeof part === "string")
      .join("");
    // LIVE ポリシーから避けている集合を復元し probe と和集合を取るステート
    expect(defText).toContain('"MergeLiveAvoid"');
    expect(defText).toContain("$liveAvoid");
    expect(defText).toContain("moved = true");
    // 和集合ベースの fail-close 判定
    expect(defText).toContain('"EffectiveFailClose"');
    // 和集合の結果は外側 $agg と同名にできない (SFN の変数スコープ仕様) ため
    // 別名 aggEff に束縛し、fail-close の Pass も参照変数ごとに分離している
    expect(defText).toContain("aggEff");
    expect(defText).toContain('"FailCloseEffective"');
  });
});

describe("MonitoringStack", () => {
  const app = newApp();
  const orchestrator = new OrchestratorStack(app, "Orchestrator", {
    env: { account: "111111111111", region: "us-west-2" },
    coreNetworkId: "core-network-0000",
    coreNetworkArn: "arn:aws:networkmanager::111111111111:core-network/core-network-0000",
    probeTargets: [
      { region: "us-east-1", azName: "us-east-1a", functionArn: "arn:aws:lambda:us-east-1:111111111111:function:probe-us-east-1a", functionName: "probe-us-east-1a" },
      { region: "us-east-1", azName: "us-east-1b", functionArn: "arn:aws:lambda:us-east-1:111111111111:function:probe-us-east-1b", functionName: "probe-us-east-1b" },
    ],
  });
  const stack = new MonitoringStack(app, "Monitoring", {
    env: { account: "111111111111", region: "us-west-2" },
    stateMachine: orchestrator.stateMachine,
    orchestratorLogGroup: orchestrator.logGroup,
    coreNetworkId: "core-network-0000",
    probeAlarmArns: [
      "arn:aws:cloudwatch:us-east-1:111111111111:alarm:probe-a",
      "arn:aws:cloudwatch:us-east-1:111111111111:alarm:probe-b",
    ],
    probeTargets: [
      { region: "us-east-1", azName: "us-east-1a", functionArn: "arn:aws:lambda:us-east-1:111111111111:function:probe-us-east-1a", functionName: "probe-us-east-1a" },
      { region: "us-east-1", azName: "us-east-1b", functionArn: "arn:aws:lambda:us-east-1:111111111111:function:probe-us-east-1b", functionName: "probe-us-east-1b" },
    ],
    firewallNames: {
      "us-east-1": "UsEast1RegionStack-Nfw",
      "ap-northeast-1": "ApNortheast1RegionStack-Nfw",
      "ap-northeast-3": "ApNortheast3RegionStack-Nfw",
    },
    natGateways: {
      "us-east-1": [
        { azName: "us-east-1a", natGatewayId: "nat-us-east-1a" },
        { azName: "us-east-1b", natGatewayId: "nat-us-east-1b" },
      ],
      "ap-northeast-1": [
        { azName: "ap-northeast-1a", natGatewayId: "nat-ap-northeast-1a" },
        { azName: "ap-northeast-1c", natGatewayId: "nat-ap-northeast-1c" },
      ],
      "ap-northeast-3": [
        { azName: "ap-northeast-3a", natGatewayId: "nat-ap-northeast-3a" },
        { azName: "ap-northeast-3b", natGatewayId: "nat-ap-northeast-3b" },
      ],
    },
  });
  const t = Template.fromStack(stack);

  test("snapshot", () => expect(t.toJSON()).toMatchSnapshot());

  test("ダッシュボードが 1 つ (名前は config の定数)", () => {
    t.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    t.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: "nfg-failover-operations",
    });
  });

  test("ダッシュボードにカスタムメトリクスとクロスリージョン参照が入る", () => {
    const body = JSON.stringify(
      Object.values(t.findResources("AWS::CloudWatch::Dashboard"))[0],
    );
    expect(body).toContain("ProbeUnhealthy");
    expect(body).toContain("ProbeHealthy");
    expect(body).toContain("ProbeLatencyMs");
    expect(body).toContain("ProbeTier2Contact");
    expect(body).toContain("OrchestratorFailClose");
    expect(body).toContain("AWS/Network Manager");
    expect(body).toContain("ap-northeast-1");
  });

  test("アラーム 7 個 (すべてアクションなし)", () => {
    t.resourceCountIs("AWS::CloudWatch::Alarm", 7);
    const alarms = Object.values(t.findResources("AWS::CloudWatch::Alarm")) as any[];
    for (const a of alarms) {
      expect(a.Properties.AlarmActions).toBeUndefined();
    }
  });
});
