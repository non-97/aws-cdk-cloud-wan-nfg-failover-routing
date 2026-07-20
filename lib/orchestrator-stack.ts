import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import {
  CLOUDWAN,
  FAILOVER,
  FAILOVER_ROLE_INSPECTION_CWAN_RT,
  MONITORING,
  REGION_CONFIGS,
  SEND_VIA_OVERRIDE_MODE,
  isNfgRegion,
  nfgPriorityMap,
  preferredNfgByEdge,
  sendViaPairs,
} from "./config";

/** 各 NFG リージョン×AZ のヘルスチェック Lambda (Orchestrator が cross-region invoke) */
export interface ProbeTarget {
  readonly region: string;
  readonly azLetter: string;
  readonly functionArn: string;
}

export interface OrchestratorStackProps extends cdk.StackProps {
  /** Cloud WAN Core Network ID */
  readonly coreNetworkId: string;
  /** Cloud WAN Core Network ARN (networkmanager の IAM 絞り込みに使う) */
  readonly coreNetworkArn: string;
  /** 全 NFG リージョン×AZ のヘルスチェック Lambda 参照 */
  readonly probeTargets: ProbeTarget[];
}

/**
 * フェイルオーバーのオーケストレーター (us-west-2)。
 *
 * Step Functions (JSONata モード) + EventBridge Scheduler で構成する。Lambda は
 * health-check のみ (本 Stack は cross-region SDK 統合の Singleton proxy Lambda を CDK が
 * 自動生成するが、フェイルオーバーロジック自体は ASL/JSONata に持つ)。
 *
 * 流れ: health-check 並列 invoke -> JSONata 集計 (avoidRegions / replaceTargets / failClose)
 *       -> Parallel( 片AZ障害は ReplaceRoute / 両AZ障害は PolicyRewrite 1回 )。
 * 排他制御は DynamoDB を使わず、PolicyRewrite 冒頭の状態確認 + Cloud WAN の ConflictException。
 */
export class OrchestratorStack extends cdk.Stack {
  /** MonitoringStack が SFN ネイティブメトリクスの参照に使う */
  public readonly stateMachine: sfn.StateMachine;
  /** MonitoringStack が Logs Insights ウィジェットの対象に使う */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: OrchestratorStackProps) {
    super(scope, id, props);

    const priorityMapLiteral = JSON.stringify(nfgPriorityMap());
    const allRegions = REGION_CONFIGS.map((r) => r.region);
    const nfgRegions = REGION_CONFIGS.filter(isNfgRegion).map((r) => r.region);

    // 1) ヘルスチェック: 全 NFG リージョン×AZ を並列 invoke (応答なし/異常 -> unhealthy)。
    //    確認再測定 (レビュー指摘 4) 用に同一構成のブランチ群を 2 セット生成するため
    //    ヘルパー化する (ステート ID は ASL 全体で一意が必須のため prefix で分ける)
    const buildHealthCheckParallel = (prefix: string): sfn.Parallel => {
      const parallel = new sfn.Parallel(this, `${prefix}All`, {
        queryLanguage: sfn.QueryLanguage.JSONATA,
        // 各ブランチの outputs を配列で集める
        outputs: "{% $states.result %}",
      });
      for (const t of props.probeTargets) {
        const invoke = tasks.CallAwsServiceCrossRegion.jsonata(
          this,
          `${prefix}-${t.region}-${t.azLetter}`,
        {
          service: "lambda",
          action: "invoke",
          region: t.region,
          parameters: { FunctionName: t.functionArn },
          iamResources: [t.functionArn],
          iamAction: "lambda:InvokeFunction",
          taskTimeout: sfn.Timeout.duration(
            cdk.Duration.seconds(FAILOVER.healthCheckTimeoutSeconds),
          ),
          // proxy Lambda は Payload が有効な JSON ならパース済みオブジェクト、
          // そうでなければ文字列で返す (aws-cdk-lib の cross-region-aws-sdk-handler
          // ソースで確認済み)。$parse を無条件に呼ぶとオブジェクトで実行時エラーになる。
          // また関数内例外 / 関数タイムアウトは FunctionError 付きの invoke 成功で返り
          // タスクの Catch では拾えないため、ここで明示的に unhealthy へ倒す。
          // healthy キー欠落も `= true` の比較で false になる (fail-close 方向)。
          outputs: {
            region: t.region,
            azLetter: t.azLetter,
            healthy:
              "{% ($p := $states.result.Payload; $body := $type($p) = 'string' ? $parse($p) : $p; $exists($states.result.FunctionError) ? false : $body.healthy = true) %}",
          },
        },
      );
        // 応答なし (タイムアウト) / エラーは「そのAZ障害」とみなす
        invoke.addCatch(
          sfn.Pass.jsonata(this, `${prefix}Fail-${t.region}-${t.azLetter}`, {
            outputs: { region: t.region, azLetter: t.azLetter, healthy: false },
          }),
          { errors: ["States.ALL"] },
        );
        parallel.branch(invoke);
      }
      return parallel;
    };
    const healthCheckAll = buildHealthCheckParallel("HealthCheck");
    // 確認再測定用の 2 セット目 (1 回目で異常を検知したときだけ実行される)
    const healthCheckConfirmAll = buildHealthCheckParallel("HealthCheckConfirm");

    // 2) 集計: health 配列 -> { avoidRegions, replaceTargets, failoverTarget, failClose }
    //    リージョン退避 (avoid) は「全 AZ down」のときのみ。一部 AZ が生存していれば
    //    ReplaceRoute の対象にする。failedAzs は down だった全 AZ で、退避先は
    //    生存 AZ の先頭 1 つ。AZ 数に依存しない判定 (2 AZ 構成では従来の
    //    「2 本失敗 = 退避」と同値)。
    //    優先度マップ ($priority) は config から注入し、JSONata 側で次点を計算する。
    //    注意: フィルタ述語内の $ は外側のコンテキストではなく被フィルタ要素を指すため、
    //    リージョン文字列は $r に束縛してから参照する (TestState で実機確認済み)。
    //    down / up / avoid / replace は [] で囲み、シーケンスの単一要素化を防いで常に配列にする。
    //    式本体は 1 回目 (Aggregate) と確認再測定後 (AggregateConfirm) で共有するため、
    //    入力の results 式だけを差し替えられる形にする。
    const aggregateBody = (resultsExpr: string): string => [
      "(",
      `  $results := ${resultsExpr};`,
      "  $regions := $distinct($results.region);",
      `  $priority := ${priorityMapLiteral};`,
      "  $perRegion := $regions.(",
      "    $r := $;",
      "    {",
      '      "region": $r,',
      '      "down": [$results[region = $r and healthy = false].azLetter],',
      '      "up": [$results[region = $r and healthy = true].azLetter]',
      "    }",
      "  );",
      "  $avoid := [$perRegion[$count(up) = 0].region];",
      "  $replace := [$perRegion[$count(down) > 0 and $count(up) > 0].{",
      '    "region": region, "failedAzs": down, "survivorAz": up[0]',
      "  }];",
      "  $candidates := $keys($priority)[$not($ in $avoid)];",
      "  $target := $count($candidates) > 0",
      // order-by (^) で優先度昇順ソートし先頭 = 最優先 (優先度番号が最小)
      "    ? ($candidates^($lookup($priority, $)))[0]",
      "    : null;",
      "  {",
      '    "avoidRegions": $avoid,',
      '    "replaceTargets": $replace,',
      '    "failoverTarget": $target,',
      // 残存 NFG が 0 = 全 NFG ダウン (= avoidRegions が全 NFG を含む)。これが fail-close 条件。
      '    "failClose": $count($candidates) = 0',
      "  }",
      ")",
    ].join("\n");

    // 1 回目の結果を probe1 に保持する (確認再測定のマージで (region, azLetter) 突合に使う)
    const aggregate = sfn.Pass.jsonata(this, "Aggregate", {
      assign: {
        probe1: "{% $states.input %}",
        agg: `{% ${aggregateBody("$states.input")} %}`,
      },
    });

    // 3) Parallel: (a) 片AZ障害の ReplaceRoute / (b) 両AZ障害の PolicyRewrite。
    //    注意: ReplaceRoute 側は全て Catch 済みで PolicyRewrite を道連れにしないが、
    //    逆に PolicyRewrite 側の未 Catch 失敗 (ExecuteChangeSet の例外等) は Parallel の
    //    仕様上 ReplaceRoute ブランチを中断し得る (通常は先に完走している。中断しても
    //    次サイクルの再評価で吸収される)
    const failoverParallel = new sfn.Parallel(this, "FailoverActions", {
      queryLanguage: sfn.QueryLanguage.JSONATA,
      outputs: "{% $states.result %}",
    });

    // (a) ReplaceRoute: 各 NFG リージョン x AZ を静的展開し、対象なら付け替え
    const azLettersByRegion = Object.fromEntries(
      nfgRegions.map((r) => [
        r,
        props.probeTargets
          .filter((t) => t.region === r)
          .map((t) => t.azLetter),
      ]),
    );
    const replaceRouteChain = this.buildReplaceRouteBranch(
      nfgRegions,
      azLettersByRegion,
    );
    failoverParallel.branch(replaceRouteChain);

    // (b) PolicyRewrite: avoidRegions 集約で 1 回だけ
    const policyChain = this.buildPolicyRewriteBranch(
      props.coreNetworkId,
      props.coreNetworkArn,
      allRegions,
      nfgRegions,
    );
    failoverParallel.branch(policyChain);

    // 2.5) 確認再測定 (レビュー指摘 4): ReplaceRoute / avoid は復旧が手動の不可逆
    // アクションのため、単一サイクルの瞬断誤検知で発動させない。1 回目で異常が出た
    // ときだけ confirmDelaySeconds 待って 2 回目を測定し、両方 unhealthy の AZ だけを
    // 障害と確定する。平常時 (異常ゼロ) は追加 invoke なしで直行する。
    // 1 回目 healthy の AZ は 2 回目の結果に関わらず今回は healthy 扱い
    // (悪化は次サイクルの 1 回目として改めて検知される)。
    // agg の再 assign は Aggregate と同一 (トップレベル) スコープのため仕様上可
    // (禁止されるのは外側と同名の「内側スコープでの」Assign のみ)
    const needConfirm = sfn.Choice.jsonata(this, "NeedConfirm");
    const waitConfirm = sfn.Wait.jsonata(this, "WaitConfirm", {
      time: sfn.WaitTime.duration(
        cdk.Duration.seconds(FAILOVER.confirmDelaySeconds),
      ),
    });
    const mergedResultsExpr = [
      "[$probe1.(",
      "  $p := $;",
      "  $m := $states.input[region = $p.region and azLetter = $p.azLetter][0];",
      '  { "region": $p.region, "azLetter": $p.azLetter, "healthy": $p.healthy or $m.healthy = true }',
      ")]",
    ].join("\n");
    const aggregateConfirm = sfn.Pass.jsonata(this, "AggregateConfirm", {
      assign: { agg: `{% ${aggregateBody(mergedResultsExpr)} %}` },
    });
    needConfirm.when(
      sfn.Condition.jsonata(
        "{% $count($agg.avoidRegions) = 0 and $count($agg.replaceTargets) = 0 %}",
      ),
      failoverParallel,
    );
    // 確認再測定の結果、確定した異常がゼロになった場合は ConfirmationCanceled を
    // 経由させ、メトリクスで可視化する (1 回目の検知が取り消された = 断続的な瞬断の
    // 痕跡。この状態が繰り返される場合はしきい値やヘルスチェック基盤の調査が必要)
    const confirmationCanceled = sfn.Pass.jsonata(this, "ConfirmationCanceled", {
      outputs: { confirmationCanceled: true },
    });
    const confirmOutcome = sfn.Choice.jsonata(this, "ConfirmOutcome");
    confirmOutcome.when(
      sfn.Condition.jsonata(
        "{% $count($agg.avoidRegions) = 0 and $count($agg.replaceTargets) = 0 %}",
      ),
      confirmationCanceled,
    );
    confirmOutcome.otherwise(failoverParallel);
    confirmationCanceled.next(failoverParallel);
    needConfirm.otherwise(waitConfirm);
    waitConfirm.next(healthCheckConfirmAll);
    healthCheckConfirmAll.next(aggregateConfirm);
    aggregateConfirm.next(confirmOutcome);

    const definition = healthCheckAll.next(aggregate).next(needConfirm);

    // フェイルオーバーの監査 / JSONata の実機デバッグのため実行ログを残す
    const logGroup = new logs.LogGroup(this, "OrchestratorLogs", {
      // 監査要件を想定した 1 年保持 + 残置 (config.ts の MONITORING.logRetentionDays)
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.logGroup = logGroup;

    // 実行ログから運用イベントをカスタムメトリクス化する (docs の「実行結果の読み方」と対応)。
    // 注意: SFN 実行ログの JSON スキーマ (type / details.name) は公式リファレンスに明記が
    // ないため (API の HistoryEvent から type 値のみ確認済み)、パターンの実マッチは
    // 実機検証 22 で確認し、必要なら調整する
    const stateMetric = (
      id: string,
      metricName: string,
      pattern: string,
    ): logs.MetricFilter =>
      new logs.MetricFilter(this, id, {
        logGroup,
        metricNamespace: MONITORING.namespace,
        metricName,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricValue: "1",
      });
    // fail-close の Pass は 2 ステートある (probe 速路の FailClose / 和集合判定の
    // FailCloseEffective) ため両方を OR で拾う
    stateMetric(
      "FailCloseMetric",
      "OrchestratorFailClose",
      '{ $.type = "PassStateEntered" && ($.details.name = "FailClose" || $.details.name = "FailCloseEffective") }',
    );
    stateMetric(
      "FailoverDoneMetric",
      "OrchestratorFailoverDone",
      '{ $.type = "SucceedStateEntered" && $.details.name = "FailoverDone" }',
    );
    stateMetric(
      "PutPolicyMetric",
      "OrchestratorPutPolicy",
      '{ $.type = "TaskStateEntered" && $.details.name = "PutPolicy" }',
    );
    stateMetric(
      "SkipAlreadyAppliedMetric",
      "OrchestratorSkipAlreadyApplied",
      '{ $.type = "PassStateEntered" && $.details.name = "SkipAlreadyApplied" }',
    );
    // ReplaceRouteFailed-<region> は NFG リージョンごとの静的ステート名のため、
    // ワイルドカードではなく完全一致の OR で生成する (引用文字列内の * は出典未確認のため使わない)
    const replaceRouteFailedNames = nfgRegions
      .map((r) => `$.details.name = "ReplaceRouteFailed-${r}"`)
      .join(" || ");
    stateMetric(
      "ReplaceRouteFailedMetric",
      "OrchestratorReplaceRouteFailed",
      `{ $.type = "PassStateEntered" && (${replaceRouteFailedNames}) }`,
    );
    // 成功側も同形で拾う (avoid 中に走った ReplaceRoute の可視化。レビュー指摘 3)
    const replaceRouteDoneNames = nfgRegions
      .map((r) => `$.details.name = "ReplaceRouteDone-${r}"`)
      .join(" || ");
    stateMetric(
      "ReplaceRouteDoneMetric",
      "OrchestratorReplaceRouteDone",
      `{ $.type = "PassStateEntered" && (${replaceRouteDoneNames}) }`,
    );
    // 確認再測定による検知取り消し (断続的な瞬断の痕跡) の可視化
    stateMetric(
      "ConfirmationCanceledMetric",
      "OrchestratorConfirmationCanceled",
      '{ $.type = "PassStateEntered" && $.details.name = "ConfirmationCanceled" }',
    );
    // ヘルスチェック Lambda の呼び出し自体の失敗 (Catch の Pass 通過)。検査経路の
    // unhealthy 報告 (ProbeUnhealthy) と区別でき、ヘルスチェック基盤側の異常による
    // 誤検知 (データプレーンは健全なのに退避する) の切り分けに使う
    const probeInvokeErrorNames = props.probeTargets
      .flatMap((t) => [
        `$.details.name = "HealthCheckFail-${t.region}-${t.azLetter}"`,
        `$.details.name = "HealthCheckConfirmFail-${t.region}-${t.azLetter}"`,
      ])
      .join(" || ");
    stateMetric(
      "ProbeInvokeErrorMetric",
      "OrchestratorProbeInvokeError",
      `{ $.type = "PassStateEntered" && (${probeInvokeErrorNames}) }`,
    );

    const stateMachine = new sfn.StateMachine(this, "Orchestrator", {
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      // ポーリング上限の合計 (ヘルスチェック 0.5 分 x 2 + 確認待機 1.5 分 + 生成待ち 5 分
      // + 実行待ち 15 分 = 22.5 分) + 余裕。
      // RTO 30 分の計測はトラフィック断の実測で行い、この timeout は安全弁
      timeout: cdk.Duration.minutes(25),
      tracingEnabled: true,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });
    this.stateMachine = stateMachine;

    // PutCoreNetworkPolicy は内部でポリシーに含まれる全リージョンのオプトイン状態を
    // 確認する。この確認に次の 3 権限が必要 (実機検証で特定: AdministratorAccess では
    // 成功し、networkmanager:PutCoreNetworkPolicy 単独では AccessDeniedException
    // "Unable to determine opt-in region status" で失敗する)。
    // CallAwsService の iamAction だけでは付与されない裏の依存権限
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "account:GetRegionOptStatus",
          "account:ListRegions",
          "ec2:DescribeRegions",
        ],
        resources: ["*"],
      }),
    );

    // 4) EventBridge Scheduler: 3 分間隔で起動 (レベルトリガー)。
    // 無効状態でデプロイする: デプロイ直後は Cloud WAN のルート伝播が未完了で、
    // リージョン間の立ち上がり速度差により、遅いリージョンが誤って avoid と確定される
    // (一度避けると手動復旧まで戻らない) ため。ダッシュボードの ProbeHealthy で
    // 立ち上がり完了を確認してから手動で有効化する (README のデプロイ手順)。
    // CloudFormation 更新のたびに無効へ戻るのは意図した安全側の挙動で、
    // 有効化忘れは ExecutionStoppedAlarm (15 分実行なし) が検知する
    new scheduler.Schedule(this, "FailoverSchedule", {
      scheduleName: "nfg-failover-health-check",
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(3)),
      target: new schedulerTargets.StepFunctionsStartExecution(stateMachine, {}),
      description: "Cloud WAN NFG failover health check (level-triggered)",
      enabled: false,
    });
  }

  /**
   * ReplaceRoute ブランチ。各 NFG リージョン x AZ を静的展開し、replaceTargets に
   * 含まれるリージョンの障害 AZ (failedAzs) の RT を、生存 AZ の NF endpoint へ
   * ReplaceRoute で付け替える。AZ ごとの分岐は synth 時に静的展開する (Map ステートは
   * TestState で直接検証できないため使わない)。
   */
  private buildReplaceRouteBranch(
    nfgRegions: string[],
    azLettersByRegion: Record<string, string[]>,
  ): sfn.IChainable {
    // 各 NFG リージョンの判定を 1 つの Parallel に集約し、複数リージョン同時の片AZ障害を並列処理する
    const parallel = new sfn.Parallel(this, "ReplaceRouteParallel", {
      queryLanguage: sfn.QueryLanguage.JSONATA,
      outputs: "{% $states.result %}",
    });

    for (const region of nfgRegions) {
      const azLetters = azLettersByRegion[region];
      const describe = tasks.CallAwsServiceCrossRegion.jsonata(
        this,
        `DescribeRt-${region}`,
        {
          service: "ec2",
          action: "describeRouteTables",
          region,
          parameters: {
            Filters: [
              {
                Name: `tag:${CLOUDWAN.tagKey.failoverRole}`,
                Values: [FAILOVER_ROLE_INSPECTION_CWAN_RT],
              },
              {
                Name: `tag:${CLOUDWAN.tagKey.failoverRegion}`,
                Values: [region],
              },
            ],
          },
          iamResources: ["*"],
          iamAction: "ec2:DescribeRouteTables",
          // AZ ごとの RT ID (synth 時に AZ 数ぶん静的展開) と、生存 AZ 自身の
          // NF endpoint を抽出する。向け先は RT に焼き込んだ failover-endpoint タグが
          // 唯一のソース (RT の現在の 0/0 から推測しない。レビュー指摘 2)
          assign: Object.fromEntries([
            ...azLetters.map((az) => [
              `rtId${az.toUpperCase()}`,
              `{% ($rts := $states.result.RouteTables; $rts[Tags[Key = "${CLOUDWAN.tagKey.failoverAz}"].Value = "${az}"][0].RouteTableId) %}`,
            ]),
            [
              "survivorEndpoint",
              `{% ($t := $agg.replaceTargets[region = "${region}"][0]; $rts := $states.result.RouteTables; $srt := $rts[Tags[Key = "${CLOUDWAN.tagKey.failoverAz}"].Value = $t.survivorAz][0]; $srt.Tags[Key = "${CLOUDWAN.tagKey.failoverEndpoint}"][0].Value) %}`,
            ],
          ]),
        },
      );

      // ReplaceRoute 系の失敗でブランチごと落とさない。Parallel は 1 ブランチの失敗で
      // 全ブランチを停止するため、Catch なしだと片AZ障害処理のエラーが同居する
      // PolicyRewrite ブランチ (両AZ障害対応) を道連れに中断してしまう。
      // 失敗は記録して完走させ、次サイクルの再評価に任せる。
      // $states.errorOutput は Catch フィールド自身の Assign / Output でのみ有効で、
      // 遷移先ステートで参照するとステートマシンのバリデーションに失敗する。
      // エラー詳細は実行履歴の失敗イベントで確認できるため、ここは静的な出力に留める
      const replaceFailed = sfn.Pass.jsonata(this, `ReplaceRouteFailed-${region}`, {
        outputs: { region, replaced: false },
      });
      describe.addCatch(replaceFailed, { errors: ["States.ALL"] });

      // 成功をメトリクス化するための着地点 (ReplaceRouteDone-<region> の
      // PassStateEntered をメトリクスフィルターが拾う)。失敗側 (ReplaceRouteFailed)
      // だけだと、avoid 中のリージョンで走った ReplaceRoute (ヘルスチェックは迂回経路を
      // 測るため局所状態を語れない) が実行履歴以外に痕跡を残さず、手動復旧時に RT の
      // 書き換えを見落とすため (レビュー指摘 3)
      const replaceDone = sfn.Pass.jsonata(this, `ReplaceRouteDone-${region}`, {
        outputs: { region, replaced: true },
      });

      // AZ ごとの分岐を末尾 (ReplaceRouteDone) から前へ組む。各 AZ の Choice は
      // 「その AZ が failedAzs に含まれるなら ReplaceRt へ、含まれないなら次の AZ 判定へ」
      const azChainStart = [...azLetters]
        .reverse()
        .reduce<sfn.IChainable>((next, az) => {
          const replace = tasks.CallAwsServiceCrossRegion.jsonata(
            this,
            `ReplaceRt-${region}-${az}`,
            {
              service: "ec2",
              action: "replaceRoute",
              region,
              parameters: {
                RouteTableId: `{% $rtId${az.toUpperCase()} %}`,
                DestinationCidrBlock: "0.0.0.0/0",
                VpcEndpointId: "{% $survivorEndpoint %}",
              },
              iamResources: ["*"],
              iamAction: "ec2:ReplaceRoute",
              outputs: { region, az, replaced: true },
            },
          );
          replace.addCatch(replaceFailed, { errors: ["States.ALL"] });
          replace.next(next);
          const needAz = sfn.Choice.jsonata(this, `NeedReplaceAz-${region}-${az}`);
          needAz.when(
            sfn.Condition.jsonata(
              `{% "${az}" in $agg.replaceTargets[region = "${region}"][0].failedAzs %}`,
            ),
            replace,
          );
          needAz.otherwise(next);
          return needAz;
        }, replaceDone);

      // このリージョンが片AZ障害の対象か判定
      const choice = sfn.Choice.jsonata(this, `NeedReplace-${region}`);
      choice.when(
        sfn.Condition.jsonata(
          `{% $count($agg.replaceTargets[region = "${region}"]) > 0 %}`,
        ),
        describe.next(azChainStart),
      );
      choice.otherwise(sfn.Pass.jsonata(this, `SkipReplace-${region}`, {}));

      parallel.branch(choice);
    }

    return parallel;
  }

  /**
   * PolicyRewrite ブランチ。両AZ障害が無ければ Pass、全NFGダウンは fail-close (ログのみ)、
   * それ以外は with-edge-overrides を生成しポリシー適用。send-to は per-edge で
   * 健全 NFG リージョンをローカルに保ち、send-via は全エッジ 1 set を次点へ向ける。
   * LIVE が望ましい override と一致していればスキップする (冪等性)。
   * NetworkManager は us-west-2 (本 Stack と同一) なので通常の CallAwsService を使う。
   */
  private buildPolicyRewriteBranch(
    coreNetworkId: string,
    coreNetworkArn: string,
    allRegions: string[],
    nfgRegions: string[],
  ): sfn.IChainable {
    const allRegionsLiteral = JSON.stringify(allRegions);
    // networkmanager の各 API は Core Network ARN リソースで絞る (最小権限)
    const nmResources = [coreNetworkArn];

    // 進行中の変更が無いか確認
    const getCoreNetwork = tasks.CallAwsService.jsonata(this, "GetCoreNetwork", {
      service: "networkmanager",
      action: "getCoreNetwork",
      parameters: { CoreNetworkId: coreNetworkId },
      iamResources: nmResources,
      iamAction: "networkmanager:GetCoreNetwork",
      assign: { coreState: "{% $states.result.CoreNetwork.State %}" },
    });

    // 現行 LIVE ポリシー取得
    const getPolicy = tasks.CallAwsService.jsonata(this, "GetLivePolicy", {
      service: "networkmanager",
      action: "getCoreNetworkPolicy",
      parameters: { CoreNetworkId: coreNetworkId, Alias: "LIVE" },
      iamResources: nmResources,
      iamAction: "networkmanager:GetCoreNetworkPolicy",
      assign: {
        liveVersionId: "{% $states.result.CoreNetworkPolicy.PolicyVersionId %}",
        liveDoc:
          "{% $type($states.result.CoreNetworkPolicy.PolicyDocument) = 'string' ? $parse($states.result.CoreNetworkPolicy.PolicyDocument) : $states.result.CoreNetworkPolicy.PolicyDocument %}",
      },
    });

    // sticky avoid: LIVE ポリシーが既に避けている集合 (liveAvoid) を send-to override の
    // 形から復元し、probe 由来の avoid と和集合を取って実効値 $aggEff に束縛する。
    // 根拠 (バグ 9): フェイルオーバー適用後、迂回済みエッジの probe は迂回先を測るため、
    // 自リージョンの障害継続を観測できない。probe だけの avoid では時間差の多重障害で
    // 2 つの誤ったポリシー間を振動する。per-edge send-to では「NFG リージョン r の
    // エッジが r 以外を向く」=「r を避けている」が 1 対 1 のため、LIVE から一意に復元できる。
    // failoverTarget / failClose も和集合から再計算する (Aggregate と同じ式形)。
    // 注意: 外側スコープで Assign 済みの $agg と同名の変数を Parallel ブランチ内で
    // Assign することは仕様で禁止されている ("a variable assigned in an inner scope
    // cannot have the same name as one assigned in an outer scope"。
    // 出典: developerguide の workflow-variables、Variable scope)。このため別名
    // $aggEff に束縛する。外側 $agg の「読み取り」は許可されているため、
    // ReplaceRoute ブランチと本ブランチの decide / FailClose はそのまま $agg を参照する。
    // マルチセグメント時の意味: $liveOvr は全 send-to アクションの override をフラット
    // 連結するため、liveAvoid は「いずれかのセグメントで別リージョンへ向いている
    // リージョンの和集合」になる (安全側。同一検査設計の前提では全セグメント同値)。
    const nfgRegionsLiteral = JSON.stringify(nfgRegions);
    const priorityLiteral = JSON.stringify(nfgPriorityMap());
    const mergeLiveAvoidExpr = [
      "(",
      '  $liveOvr := [$liveDoc.`segment-actions`[action = "send-to"].via.`with-edge-overrides`];',
      `  $nfg := ${nfgRegionsLiteral};`,
      `  $priority := ${priorityLiteral};`,
      "  $liveState := $nfg.(",
      "    $r := $;",
      "    {",
      '      "region": $r,',
      "      \"moved\": $count([$liveOvr[`edge-sets` = [[$r]] and `use-edge-location` != $r]]) > 0",
      "    }",
      "  );",
      "  $liveAvoid := [$liveState[moved = true].region];",
      "  $avoid := [$distinct($append($agg.avoidRegions, $liveAvoid))];",
      "  $candidates := $keys($priority)[$not($ in $avoid)];",
      "  {",
      '    "avoidRegions": $avoid,',
      '    "replaceTargets": [$agg.replaceTargets],',
      '    "failoverTarget": $count($candidates) > 0',
      "      ? ($candidates^($lookup($priority, $)))[0]",
      "      : null,",
      '    "failClose": $count($candidates) = 0',
      "  }",
      ")",
    ].join("\n");
    const mergeLiveAvoid = sfn.Pass.jsonata(this, "MergeLiveAvoid", {
      assign: { aggEff: `{% ${mergeLiveAvoidExpr} %}` },
    });

    // send-to 用の per-edge override 配列を生成する JSONata 部分式。
    // 各エッジは優先 NFG (NFG あり = 自身 / なし = config の preferredNfg) が
    // 健全ならそれを、死んでいれば failoverTarget を use-edge-location にする。
    // avoid が空なら baseline (core-network-policy.ts) と同一のマップになる
    // (両者は preferredNfgByEdge() を共有する)。
    // AlreadyApplied の冪等判定と PutPolicy の生成の両方に同じ式を注入する。
    const preferredMapLiteral = JSON.stringify(preferredNfgByEdge());
    const ovrToExpr = [
      "(",
      "  $avoid := $aggEff.avoidRegions;",
      "  $target := $aggEff.failoverTarget;",
      `  $allEdges := ${allRegionsLiteral};`,
      `  $preferred := ${preferredMapLiteral};`,
      "  [$allEdges.(",
      "    $edge := $;",
      "    $p := $lookup($preferred, $edge);",
      "    {",
      '      "edge-sets": [[$edge]],',
      '      "use-edge-location": $not($p in $avoid) ? $p : $target',
      "    }",
      "  )]",
      ")",
    ].join("\n");

    // send-via 用 override の per-pair 生成 (方式 C: 最小 override)。
    // 自然選択 (naturalPick) が死んだ NFG に向かうペアだけを override し、
    // 健全リージョンのローカル検査を維持する。エントリ値は「healthy な NFG 端の
    // 優先上位」か「$target」のみで、構造的に avoid 内へ向かうことはない。
    // フラグメントは synth 時に完全リテラルで合成し、$append の連鎖で連結する
    // (配列コンストラクタの undefined 挙動やシーケンス展開に依存しない形)。
    const perPairFragments = sendViaPairs().map((pair) => {
      const edgeSetLiteral = JSON.stringify([pair.edges]);
      const valueExpr = pair.nfgEndsByPriority.reduceRight<string>(
        (fallback, end) => `$not("${end}" in $avoid) ? "${end}" : (${fallback})`,
        "$target",
      );
      return `(("${pair.naturalPick}" in $avoid) ? [{ "edge-sets": ${edgeSetLiteral}, "use-edge-location": ${valueExpr} }] : [])`;
    });
    const perPairViaExpr = perPairFragments.reduce(
      (acc, frag) => `$append(${acc}, ${frag})`,
      "[]",
    );
    const ovrViaExpr: string =
      SEND_VIA_OVERRIDE_MODE === "per-pair"
        ? perPairViaExpr
        : `[{ "edge-sets": [${allRegionsLiteral}], "use-edge-location": $target }]`;

    // with-edge-overrides を現行 document へマージ。
    // send-to は per-edge ($ovrTo)、send-via は per-pair (方式 C)。
    // マルチセグメント時の意味: send-to / send-via の全アクションに同一の override を
    // 適用する (全セグメント同一検査設計の前提。他のフィールドは保存される)。
    // 詳細は docs/send-via-override-research.md。
    // 注意: edge-sets は配列の配列。JSONata の配列コンストラクタ内で配列値の変数を
    // 参照するとシーケンス展開でフラット化される ([$all] -> ["r1","r2"] になる。
    // TestState で実機確認済み)。ネストを保持するためリテラルを直接埋め込む。
    const buildOverridesExpr = [
      "(",
      `  $ovrTo := ${ovrToExpr};`,
      "  $avoid := $aggEff.avoidRegions;",
      "  $target := $aggEff.failoverTarget;",
      `  $ovrVia := ${ovrViaExpr};`,
      "  $actions := [$liveDoc.`segment-actions`.(",
      "    $a := $;",
      '    $a.action = "send-to"',
      '      ? $merge([$a, { "via": $merge([$a.via, { "with-edge-overrides": $ovrTo }]) }])',
      '      : $a.action = "send-via"',
      '        ? $merge([$a, { "via": $merge([$a.via, { "with-edge-overrides": $ovrVia }]) }])',
      "        : $a",
      "  )];",
      '  $merge([$liveDoc, {"segment-actions": $actions}])',
      ")",
    ].join("\n");

    const putPolicy = tasks.CallAwsService.jsonata(this, "PutPolicy", {
      service: "networkmanager",
      action: "putCoreNetworkPolicy",
      parameters: {
        CoreNetworkId: coreNetworkId,
        PolicyDocument: `{% $string(${buildOverridesExpr}) %}`,
        Description:
          "{% 'failover avoid=' & $join($aggEff.avoidRegions, ',') & ' from v' & $string($liveVersionId) %}",
      },
      iamResources: nmResources,
      iamAction: "networkmanager:PutCoreNetworkPolicy",
      assign: {
        newPolicyVersionId:
          "{% $states.result.CoreNetworkPolicy.PolicyVersionId %}",
        genPollCount: "{% 0 %}",
      },
    });
    // 重複実行などで同時変更がある場合のみスキップ (ConflictException)。
    // States.TaskFailed まで catch すると validation エラー等の実バグも
    // 「conflict でスキップ」と誤記録され続ける沈黙障害になるため catch しない
    // (その場合は実行が FAILED になり実行履歴で気付ける)。
    // 例外名の表記は確認済み: 同じ aws-sdk 統合の putCoreNetworkPolicy を TestState で
    // 実行し NetworkManager.ResourceNotFoundException が返ることを観測 (接頭辞を実測)。
    // ConflictException が本 API のエラーであることは API リファレンスに記載。
    putPolicy.addCatch(
      sfn.Pass.jsonata(this, "PutPolicyConflict", {
        outputs: { skipped: true, reason: "conflict" },
      }),
      { errors: ["NetworkManager.ConflictException"] },
    );

    // change set の生成は非同期 (PENDING_GENERATION -> READY_TO_EXECUTE)。
    // Put 直後に Execute すると生成前で失敗するため、READY_TO_EXECUTE を待ってから実行する。
    const waitGeneration = sfn.Wait.jsonata(this, "WaitGeneration", {
      time: sfn.WaitTime.duration(
        cdk.Duration.seconds(FAILOVER.generationPollIntervalSeconds),
      ),
    });
    const pollGeneration = tasks.CallAwsService.jsonata(
      this,
      "PollGenerationState",
      {
        service: "networkmanager",
        action: "getCoreNetworkPolicy",
        parameters: {
          CoreNetworkId: coreNetworkId,
          PolicyVersionId: "{% $newPolicyVersionId %}",
        },
        iamResources: nmResources,
        iamAction: "networkmanager:GetCoreNetworkPolicy",
        assign: {
          genState: "{% $states.result.CoreNetworkPolicy.ChangeSetState %}",
          genPollCount: "{% $genPollCount + 1 %}",
        },
      },
    );
    const generationFailed = sfn.Fail.jsonata(this, "GenerationFailed", {
      error: "ChangeSetNotGenerated",
      cause:
        "change set did not reach READY_TO_EXECUTE within the generation poll limit (see genState/genPollCount in execution history)",
    });
    // 生成中に別バージョンが作られた場合 (OUT_OF_DATE)。次サイクルが再評価して Put し直す
    const skipSuperseded = sfn.Pass.jsonata(this, "SkipSuperseded", {
      outputs: { skipped: true, reason: "superseded-by-newer-version" },
    });

    const execute = tasks.CallAwsService.jsonata(this, "ExecuteChangeSet", {
      service: "networkmanager",
      action: "executeCoreNetworkChangeSet",
      parameters: {
        CoreNetworkId: coreNetworkId,
        PolicyVersionId: "{% $newPolicyVersionId %}",
      },
      iamResources: nmResources,
      iamAction: "networkmanager:ExecuteCoreNetworkChangeSet",
      // ポーリングカウンタ初期化
      assign: { pollCount: "{% 0 %}" },
    });

    // change set 完了をポーリング。
    // 注意: GetCoreNetworkChangeSet の応答には実行状態 (State) が無いため、
    // GetCoreNetworkPolicy (PolicyVersionId 指定) の CoreNetworkPolicy.ChangeSetState を見る。
    // 値: PENDING_GENERATION | FAILED_GENERATION | READY_TO_EXECUTE | EXECUTING |
    //     EXECUTION_SUCCEEDED | OUT_OF_DATE
    const wait = sfn.Wait.jsonata(this, "WaitChangeSet", {
      time: sfn.WaitTime.duration(
        cdk.Duration.seconds(FAILOVER.changeSetPollIntervalSeconds),
      ),
    });
    const getChangeSet = tasks.CallAwsService.jsonata(
      this,
      "PollChangeSetState",
      {
        service: "networkmanager",
        action: "getCoreNetworkPolicy",
        parameters: {
          CoreNetworkId: coreNetworkId,
          PolicyVersionId: "{% $newPolicyVersionId %}",
        },
        iamResources: nmResources,
        iamAction: "networkmanager:GetCoreNetworkPolicy",
        assign: {
          changeSetState:
            "{% $states.result.CoreNetworkPolicy.ChangeSetState %}",
          pollCount: "{% $pollCount + 1 %}",
        },
      },
    );
    const done = sfn.Succeed.jsonata(this, "FailoverDone");
    const failed = sfn.Fail.jsonata(this, "FailoverPolicyFailed", {
      error: "ChangeSetNotApplied",
      cause:
        "change set reached FAILED_GENERATION or OUT_OF_DATE during execution (see execution history for state/pollCount)",
    });
    // ポーリング上限到達を Fail にしない。change set の実行はサーバー側で継続するため
    // Fail にすると「偽の失敗」になる。正常終了して次サイクルに引き継ぐ
    // (実行中は GetCoreNetwork = UPDATING でスキップ、完了後は AlreadyApplied でスキップ)。
    const stillExecuting = sfn.Pass.jsonata(this, "ChangeSetStillExecuting", {
      outputs: {
        stillExecuting: true,
        policyVersionId: "{% $newPolicyVersionId %}",
      },
    });
    const pollChoice = sfn.Choice.jsonata(this, "ChangeSetComplete");
    pollChoice.when(
      sfn.Condition.jsonata('{% $changeSetState = "EXECUTION_SUCCEEDED" %}'),
      done,
    );
    pollChoice.when(
      sfn.Condition.jsonata(
        '{% $changeSetState = "FAILED_GENERATION" or $changeSetState = "OUT_OF_DATE" %}',
      ),
      failed,
    );
    pollChoice.when(
      sfn.Condition.jsonata(
        `{% $pollCount >= ${FAILOVER.changeSetPollMaxAttempts} %}`,
      ),
      stillExecuting,
    );
    pollChoice.otherwise(wait);
    // getChangeSet -> Choice -> (otherwise) wait -> getChangeSet のループ。
    // getChangeSet.next は 1 回だけ。execute / wait の双方から getChangeSet へ合流する。
    getChangeSet.next(pollChoice);
    wait.next(getChangeSet);

    // 冪等性チェック: LIVE の send-to / send-via の overrides が望ましい値と
    // deep-equal なら適用済みとみなしスキップする。send-to のみの比較では、
    // send-via の生成方式を変更したデプロイ更新後に古い send-via が残るケースを
    // 取りこぼすため、両方を比較する。
    // 比較は**アクション単位** ($filter + 無名関数) で行う。セグメントが複数になると
    // send-to / send-via アクションも複数並び、旧実装のフラット連結 (全アクションの
    // overrides を 1 配列に連結) では望ましい値 (1 アクション分) と恒久的に不一致となり、
    // 毎サイクル無駄な PutPolicy を繰り返す (空振り更新) ためである。
    // 前提: 全セグメントが同一の検査設計 (同じ NFG / 同じ優先 NFG マップ) を持つこと。
    // セグメントごとに検査設計を変える場合はこの機構の拡張が必要 (README の
    // 「本番転用時の制約」)。
    // [$...] で包んでシーケンスを常に配列へ正規化する (overrides 欠落時は [])。
    // baseline (live=[] / desired=非空) は不一致で適用、適用済みは一致でスキップ、
    // 望ましい override が空 (desired=[]) のときは live=[] なら一致 / live=非空なら
    // 不一致 (stale 除去) となり、どのケースも正しく収束する。
    // $count($toActions) > 0 のガードは「send-to アクションが 1 つも無い異常なポリシー」
    // を適用済みと誤判定しないための保険である。
    // $aggEff は直前の MergeLiveAvoid で liveAvoid と和集合済みの実効値である。
    const alreadyAppliedExpr = [
      "(",
      '  $toActions := [$liveDoc.`segment-actions`[action = "send-to"]];',
      '  $viaActions := [$liveDoc.`segment-actions`[action = "send-via"]];',
      `  $desiredTo := ${ovrToExpr};`,
      `  $desiredVia := ( $avoid := $aggEff.avoidRegions; $target := $aggEff.failoverTarget; ${ovrViaExpr} );`,
      "  $staleTo := $count($filter($toActions, function($a) { [$a.via.`with-edge-overrides`] != $desiredTo }));",
      "  $staleVia := $count($filter($viaActions, function($a) { [$a.via.`with-edge-overrides`] != $desiredVia }));",
      "  $count($toActions) > 0 and $staleTo = 0 and $staleVia = 0",
      ")",
    ].join("\n");

    const skipAlreadyApplied = sfn.Pass.jsonata(this, "SkipAlreadyApplied", {
      outputs: { skipped: true, reason: "already-applied" },
    });
    const alreadyApplied = sfn.Choice.jsonata(this, "AlreadyApplied");
    alreadyApplied.when(
      sfn.Condition.jsonata(`{% ${alreadyAppliedExpr} %}`),
      skipAlreadyApplied,
    );
    // 生成完了待ちループ: Put -> (PollGenerationState -> GenerationReady? -> Wait) -> Execute
    const generationReady = sfn.Choice.jsonata(this, "GenerationReady");
    generationReady.when(
      sfn.Condition.jsonata('{% $genState = "READY_TO_EXECUTE" %}'),
      execute,
    );
    generationReady.when(
      sfn.Condition.jsonata('{% $genState = "FAILED_GENERATION" %}'),
      generationFailed,
    );
    generationReady.when(
      sfn.Condition.jsonata('{% $genState = "OUT_OF_DATE" %}'),
      skipSuperseded,
    );
    generationReady.when(
      sfn.Condition.jsonata(
        `{% $genPollCount >= ${FAILOVER.generationPollMaxAttempts} %}`,
      ),
      generationFailed,
    );
    generationReady.otherwise(waitGeneration);
    pollGeneration.next(generationReady);
    waitGeneration.next(pollGeneration);
    execute.next(getChangeSet);

    alreadyApplied.otherwise(putPolicy.next(pollGeneration));

    // fail-close / 何もしない / フェイルオーバー実行 の分岐。
    // fail-close の Pass は 2 つある: FailClose は decide (probe 全滅の速路) 用で
    // 外側の $agg を、FailCloseEffective は EffectiveFailClose (liveAvoid との和集合で
    // 全滅) 用で $aggEff を参照する。参照する変数が異なるため 1 ステートに共有できない
    // ($aggEff は MergeLiveAvoid を通らない decide 経路では未定義)。
    // メトリクスフィルター (OrchestratorFailClose) は両ステート名を OR で拾う。
    const failClose = sfn.Pass.jsonata(this, "FailClose", {
      // ポリシー変更せずログのみ (通知は別途)。CloudWatch Logs に出力される。
      outputs: { failClose: true, avoidRegions: "{% $agg.avoidRegions %}" },
    });
    const failCloseEffective = sfn.Pass.jsonata(this, "FailCloseEffective", {
      outputs: { failClose: true, avoidRegions: "{% $aggEff.avoidRegions %}" },
    });
    const noop = sfn.Pass.jsonata(this, "NoRegionFailover", {});

    // 和集合の結果 fail-close に到達するケースの判定。probe は一部の障害しか
    // 検出できなくても、liveAvoid を合わせると残存 NFG が 0 になり得る
    // (例: apne1 迂回中に use1 / apne3 が両AZ断)。従来はこのケースで死んだ
    // target へ全エッジを向ける誤適用になっていた。
    const effectiveFailClose = sfn.Choice.jsonata(this, "EffectiveFailClose");
    effectiveFailClose.when(
      sfn.Condition.jsonata("{% $aggEff.failClose = true %}"),
      failCloseEffective,
    );
    effectiveFailClose.otherwise(alreadyApplied);

    const applyChain = getPolicy.next(mergeLiveAvoid).next(effectiveFailClose);

    // GetCoreNetwork の State が AVAILABLE のときだけポリシー変更へ進む。
    // UPDATING (進行中) 等なら重複処理を避けてスキップ (排他制御。重なった実行は次サイクルが再評価)。
    const skipInProgress = sfn.Pass.jsonata(this, "SkipInProgress", {
      outputs: { skipped: true, reason: "core-network-not-available" },
    });
    const availableChoice = sfn.Choice.jsonata(this, "CoreNetworkAvailable");
    availableChoice.when(
      sfn.Condition.jsonata('{% $coreState = "AVAILABLE" %}'),
      applyChain,
    );
    availableChoice.otherwise(skipInProgress);

    const decide = sfn.Choice.jsonata(this, "RegionFailoverDecision");
    decide.when(
      sfn.Condition.jsonata("{% $agg.failClose = true %}"),
      failClose,
    );
    decide.when(
      sfn.Condition.jsonata("{% $count($agg.avoidRegions) = 0 %}"),
      noop,
    );
    decide.otherwise(getCoreNetwork.next(availableChoice));

    return decide;
  }
}
