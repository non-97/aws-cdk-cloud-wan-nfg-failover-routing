/**
 * 検証環境の設定を一元管理する。
 * リージョン / CIDR / ASN / 優先度 / タグ / セグメント名、およびフェイルオーバー定数をここで定義し、
 * Stack / Construct には Props 経由で注入する。
 *
 * フェイルオーバーのポリシー操作 (with-edge-overrides 網羅生成) はランタイム
 * (JSONata Step Functions) 側で行う。本ファイルは baseline ポリシー生成に必要な構成と、
 * 優先度テーブル / 次点リージョン計算の純関数を提供する (優先度の値はここが唯一のソース)。
 */

/** 使用するリージョン */
export const REGIONS = {
  usEast1: "us-east-1",
  usWest2: "us-west-2",
  apNortheast1: "ap-northeast-1",
  apNortheast3: "ap-northeast-3",
  apSoutheast1: "ap-southeast-1",
} as const;

/** Core Network 本体 (GlobalNetwork / CoreNetwork) を配置するリージョン (Network Manager のホーム) */
export const CORE_STACK_REGION = REGIONS.usWest2;

/** オーケストレーター (Step Functions / Scheduler) を配置するリージョン */
export const ORCHESTRATOR_REGION = REGIONS.usWest2;

/** Core Network / アタッチメントで使う固定値 */
export const CLOUDWAN = {
  /** Core Network のエッジに割り当てる ASN レンジ */
  asnRange: "64512-64555",
  /** Workload VPC を収容する単一セグメント */
  segment: "workload",
  /** Inspection VPC を収容する単一 Network Function Group */
  nfg: "inspection",
  /** アタッチメントの自動割当 / フェイルオーバー対象特定に使うタグキー */
  tagKey: {
    /** セグメント自動割当 (Workload / HealthCheck VPC) */
    segment: "cloudwan-seg",
    /** NFG 自動割当 (Inspection VPC) */
    nfg: "cloudwan-nfg",
    /** ReplaceRoute 対象の RT を特定する役割タグ */
    failoverRole: "failover-role",
    /** ReplaceRoute 対象の RT が属するリージョン */
    failoverRegion: "failover-region",
    /** ReplaceRoute 対象の RT が属する実 AZ 名 */
    failoverAz: "failover-az",
    /**
     * その RT の AZ 自身の NF エンドポイント ID (vpce-xxx)。ReplaceRoute の向け先は
     * このタグから取る。「生存 AZ の RT が現在指している 0/0」から取ると、片AZ
     * フェイルオーバー未復旧の状態で stale になるため (レビュー指摘 2)
     */
    failoverEndpoint: "failover-endpoint",
  },
} as const;

/** failoverRole タグの値: Inspection VPC の Cloud WAN アタッチメントサブネットの RT */
export const FAILOVER_ROLE_INSPECTION_CWAN_RT = "inspection-cwan-rt";

/** フェイルオーバー / ヘルスチェックの動作パラメータ (RTO 30 分を予算とする) */
export const FAILOVER = {
  /**
   * 疎通先の tier (段階)。tier 1 から順に試行し、tier 内は並列に probe する。
   * 前の tier が全滅したときだけ次の tier へ進み、いずれかで 1 つでも接続が確立
   * すれば healthy (全 tier 全滅のときのみ疎通不可と判定し、宛先側障害の誤検知を防ぐ)。
   * tier 1 は AWS 管理: nsOfZone エントリは指定ゾーンの NS レコードを Lambda 実行時に
   * 引き、返ってきた権威ネームサーバー全台へ展開する (サーバー名も IP も焼き込まない。
   * Route 53 の権威サーバーは anycast 配信で、TCP/53 ハンドシェイクの成立は
   * 2026-07-15 に実測確認済み)。checkip.amazonaws.com は AWS 公式ドキュメント記載の
   * 管理エンドポイント。
   * tier 2 はサードパーティの公開 DNS で、最後の砦。平常時は接続しない
   * (第三者サービスへの不要な接続を避ける)。IP 直指定のため DNS 非依存で、
   * 万一名前解決に問題があっても最後の砦は判定できる。
   * 経緯は docs/probe-endpoint-research.md
   */
  probeEndpointTiers: [
    [
      { nsOfZone: "amazonaws.com", port: 53 },
      { host: "checkip.amazonaws.com", port: 443 },
    ],
    [
      { host: "1.1.1.1", port: 53 },
      { host: "8.8.8.8", port: 53 },
    ],
  ],
  /** 各エンドポイントへの 1 回あたりの接続タイムアウト (秒) */
  probeTimeoutSeconds: 3,
  /** 各エンドポイントへの試行回数 (瞬断吸収。1 回でも成功すれば ok) */
  probeAttempts: 3,
  /** 試行間隔 (秒) */
  probeIntervalSeconds: 0.3,
  /** Step Functions から health-check Lambda を待つタイムアウト (秒)。超過 = AZ 障害 */
  healthCheckTimeoutSeconds: 30,
  /**
   * 確認再測定までの待機 (秒)。1 回目の probe で異常を検知したときのみ、この秒数
   * 待って 2 回目の probe を行い、両方 unhealthy の AZ だけを障害と確定する。
   * ReplaceRoute / avoid は復旧が手動の不可逆アクションのため、単一サイクルの
   * 瞬断 (probe 1 周の最悪 約 20 秒) の誤検知で発動させない。90 秒は probe 1 周との
   * 重なりを確実に外す長さで、検知遅延 +約 2 分は RTO 30 分の予算内
   */
  confirmDelaySeconds: 90,
  /**
   * change set の生成完了 (PENDING_GENERATION -> READY_TO_EXECUTE) をポーリングする間隔 (秒)。
   * 生成は非同期のため、Put 直後に Execute すると失敗する (公式: cloudwan-create-policy-version)。
   */
  generationPollIntervalSeconds: 10,
  /** 生成ポーリングの最大回数 (10 秒 x 30 = 5 分) */
  generationPollMaxAttempts: 30,
  /** change set 実行完了をポーリングする間隔 (秒) */
  changeSetPollIntervalSeconds: 30,
  /**
   * change set 実行ポーリングの最大回数 (30 秒 x 30 = 15 分)。
   * 上限到達時は Fail ではなく正常終了し、次サイクルが引き継ぐ (実行はサーバー側で継続する)。
   */
  changeSetPollMaxAttempts: 30,
} as const;

/**
 * send-via override の生成方式。
 * per-pair: 自然選択が死んだ NFG に向かうペアだけを override し、健全リージョンの
 *           ローカル検査を維持する (公式ドキュメントに記載のない挙動に依存する。
 *           実機で受理されない場合は single-set へ変更して再デプロイする)
 * single-set: 全エッジ 1 set を failoverTarget へ向ける (実証済みの保守的方式)
 */
export const SEND_VIA_OVERRIDE_MODE: "per-pair" | "single-set" = "per-pair";

/** 監視 (ダッシュボード / カスタムメトリクス) の定数 */
export const MONITORING = {
  /** メトリクスフィルターが発行するカスタムメトリクスの名前空間 */
  namespace: "NfgFailover",
  /** us-west-2 の MonitoringStack が作成するダッシュボード名 */
  dashboardName: "nfg-failover-operations",
  /** EventBridge Scheduler の専用グループ名。ダッシュボードの SEARCH 式で他スケジュールと分離するために使う */
  scheduleGroupName: "nfg-failover",
  /**
   * ログの保持期間。監査要件を想定して 1 年とし、LogGroup の RemovalPolicy は
   * RETAIN にする (cdk destroy してもログは消えない。後片付けは手動削除)
   */
  logRetentionDays: 365,
} as const;

/** EC2 セキュリティグループの ingress 許可に使う RFC1918 帯 */
export const RFC1918_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

/** リージョンごとのネットワーク設定 */
export interface RegionConfig {
  /** リージョンコード */
  readonly region: string;
  /** Core Network エッジに割り当てる ASN (asnRange 内で一意) */
  readonly asn: number;
  /**
   * Cloud WAN の default Region priority list 上の優先度番号 (小さいほど優先)。
   * 参考プロジェクトの実機検証で確定した値。次点リージョン計算の唯一のソース。
   */
  readonly defaultPriority: number;
  /**
   * この検証アカウントで使う AZ 名 2 つ。
   * cdk.context.json のキャッシュ値をコードに固定したもの。明示することで
   * (1) context 再生成による意図しない AZ 名の変更を防ぎ、
   * (2) AZ の問い合わせ (context lookup) 自体が不要になり、cdk.context.json が
   * 無い環境でも synth が決定論的に成功する。
   * 注意: AZ 名が指す物理 AZ はアカウントごとに異なるため、別アカウントへ
   * 転用する場合は値を見直すこと
   */
  readonly availabilityZones: readonly [string, string];
  /** Workload VPC の CIDR 2 本 (全リージョンに存在)。同一リージョン内の east-west 検証用 */
  readonly workloadCidrs: readonly [string, string];
  /** Inspection VPC の CIDR。値を持つリージョンが NFG (検査) ありリージョン */
  readonly inspectionCidr?: string;
  /** HealthCheck VPC の CIDR。NFG ありリージョンのみ持つ */
  readonly healthCheckCidr?: string;
  /**
   * このエッジの egress (send-to) を平常時に向ける NFG リージョンの優先度チェーン
   * (地理グループごとのフォールバック順)。
   * NFG ありリージョンは未指定 (自身が優先 NFG。preferredNfgByEdge() がグループの
   * チェーンから自動導出する)。NFG なしリージョンは必須で、先頭がレイテンシ最小の
   * NFG リージョン、以降は同じ地理グループの NFG リージョンを優先度順に並べ、
   * 最後に他グループの NFG リージョンを続ける。フェイルオーバー時はチェーンを
   * 先頭から順に健全性判定し、最初に健全なリージョンを使う
   */
  readonly preferredNfgChain?: readonly string[];
}

/**
 * リージョン構成。
 * NFG (Inspection VPC + HealthCheck VPC) を持つのは us-east-1 / ap-northeast-1 / ap-northeast-3 の 3 つ。
 * us-west-2 は Workload のみ (NFG なし) で、オーケストレーター / Core Network のホーム。
 */
export const REGION_CONFIGS: readonly RegionConfig[] = [
  {
    region: REGIONS.usEast1,
    asn: 64512,
    defaultPriority: 1,
    availabilityZones: ["us-east-1a", "us-east-1b"],
    workloadCidrs: ["10.1.0.0/16", "10.3.0.0/16"],
    inspectionCidr: "10.0.0.0/16",
    healthCheckCidr: "10.2.0.0/16",
  },
  {
    region: REGIONS.usWest2,
    asn: 64513,
    defaultPriority: 4,
    availabilityZones: ["us-west-2a", "us-west-2b"],
    workloadCidrs: ["10.11.0.0/16", "10.13.0.0/16"],
    // US グループ: use1 → apne1 → apne3 (地理的近さの優先度チェーン)
    preferredNfgChain: [REGIONS.usEast1, REGIONS.apNortheast1, REGIONS.apNortheast3],
  },
  {
    region: REGIONS.apNortheast1,
    asn: 64514,
    defaultPriority: 7,
    availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
    workloadCidrs: ["10.21.0.0/16", "10.23.0.0/16"],
    inspectionCidr: "10.20.0.0/16",
    healthCheckCidr: "10.22.0.0/16",
  },
  {
    region: REGIONS.apNortheast3,
    asn: 64515,
    defaultPriority: 9,
    availabilityZones: ["ap-northeast-3a", "ap-northeast-3b"],
    workloadCidrs: ["10.31.0.0/16", "10.33.0.0/16"],
    inspectionCidr: "10.30.0.0/16",
    healthCheckCidr: "10.32.0.0/16",
  },
  {
    // 非 NFG リージョン (Workload のみ)。「両端に NFG がないクロスペア」の検査先
    // 選択を観測するために追加。defaultPriority の機能的な役割は一意性のみ
    // (非 NFG リージョンは failoverTarget の候補にならない)。値 11 は追加当時の
    // Region availability テーブル順からの導出。2026-07-18 時点の掲載順は 12
    // (ap-south-2 等の追加で繰り下がり) だが、値は一意性にしか使わないため据え置く。
    // 実機検証には使用しない
    region: REGIONS.apSoutheast1,
    asn: 64516,
    defaultPriority: 11,
    availabilityZones: ["ap-southeast-1a", "ap-southeast-1b"],
    workloadCidrs: ["10.41.0.0/16", "10.43.0.0/16"],
    // AP グループ: apne1 (最近傍の東京) → apne3 → use1 (地理的近さの優先度チェーン)
    preferredNfgChain: [
      REGIONS.apNortheast1,
      REGIONS.apNortheast3,
      REGIONS.usEast1,
    ],
  },
] as const;

/** 指定リージョンが NFG (検査) ありか (inspectionCidr の有無で判定) */
export const isNfgRegion = (config: RegionConfig): boolean =>
  config.inspectionCidr !== undefined;

/** NFG ありリージョンを優先度昇順 (優先度の高い順) で返す */
export const nfgRegionsByPriority = (): readonly RegionConfig[] =>
  REGION_CONFIGS.filter(isNfgRegion).slice().sort(
    (a, b) => a.defaultPriority - b.defaultPriority,
  );

/**
 * NFG ありリージョンの { リージョン: 優先度 } マップ。
 * CDK が synth 時に Step Functions の ASL へ JSONata 定数として注入する。
 */
export const nfgPriorityMap = (): Record<string, number> =>
  Object.fromEntries(
    nfgRegionsByPriority().map((r) => [r.region, r.defaultPriority]),
  );

/**
 * avoidRegions を除外した後の、残存 NFG リージョンの最優先 (次点) リージョンを返す。
 * 残存する NFG リージョンが無い場合は undefined (= fail-close)。
 * 多段フェイルオーバー: us-east-1 障害 -> ap-northeast-1 / +ap-northeast-1 -> ap-northeast-3 / 全障害 -> undefined。
 */
export const failoverTargetRegion = (
  avoidRegions: readonly string[],
): string | undefined =>
  nfgRegionsByPriority().find((r) => !avoidRegions.includes(r.region))?.region;

/** NFG なしリージョンが宣言する preferredNfgChain (バリデーション込み)。地理グループの正準チェーン */
interface RawNfgChain {
  readonly region: string;
  readonly chain: readonly string[];
}

/**
 * REGION_CONFIGS から NFG なしリージョンの preferredNfgChain を集めてバリデーションする。
 * NFG ありリージョンに指定されていた場合や、要素の過不足 (NFG ありリージョン以外を含む /
 * 重複がある / 全 NFG リージョンを含まない) はここで例外にする。
 */
const rawNfgChains = (): readonly RawNfgChain[] => {
  const nfgRegions = REGION_CONFIGS.filter(isNfgRegion).map((r) => r.region);
  return REGION_CONFIGS.filter((r) => r.preferredNfgChain !== undefined).map(
    (r) => {
      if (isNfgRegion(r)) {
        throw new Error(
          `${r.region}: NFG ありリージョンに preferredNfgChain は指定できない (自身が優先 NFG)`,
        );
      }
      const chain = r.preferredNfgChain as readonly string[];
      if (new Set(chain).size !== chain.length) {
        throw new Error(`${r.region}: preferredNfgChain に重複がある`);
      }
      if (chain.some((c) => !nfgRegions.includes(c))) {
        throw new Error(
          `${r.region}: preferredNfgChain の要素は全て NFG ありリージョンであること`,
        );
      }
      if (nfgRegions.some((n) => !chain.includes(n))) {
        throw new Error(
          `${r.region}: preferredNfgChain は全 NFG リージョンを含むこと`,
        );
      }
      return { region: r.region, chain };
    },
  );
};

/**
 * NFG ありリージョンが所属する地理グループの正準チェーンを選ぶ。
 * 「自身が最も上位にランクされる (chain 内の index が最小の) rawChain」を採用する。
 * 例: apne3 は US チェーン [use1,apne1,apne3] では index 2、AP チェーン
 * [apne1,apne3,use1] では index 1 のため AP チェーンを採用する
 * (先頭要素が自身と一致するかどうかでは判定できない。apne3 はどちらの
 * rawChain でも先頭ではないため)。
 */
const bestRawChainFor = (
  region: string,
  chains: readonly RawNfgChain[],
): readonly string[] => {
  const best = chains.reduce<{ idx: number; chain: readonly string[] }>(
    (acc, cur) => {
      const idx = cur.chain.indexOf(region);
      return idx >= 0 && idx < acc.idx ? { idx, chain: cur.chain } : acc;
    },
    { idx: Infinity, chain: [] },
  );
  if (best.chain.length === 0) {
    throw new Error(
      `${region}: preferredNfgChain を持つ NFG なしリージョンが見つからない (地理グループを導出できない)`,
    );
  }
  return best.chain;
};

/**
 * リージョンが所属する地理グループの正準チェーン (グループの全メンバーで同一の配列内容になる)。
 * NFG なしリージョンは自身の preferredNfgChain がそのままグループの正準チェーン。
 * NFG ありリージョンは bestRawChainFor で導出する。
 * send-via ペアの「同一グループ判定」に使う (2 エッジのグループチェーンが
 * 内容として一致するかどうかで判定する。先頭要素の比較では NFG ありリージョン同士の
 * 判定ができない (自身が先頭になるため常に不一致になる))。
 */
const groupChainOf = (
  region: string,
  chains: readonly RawNfgChain[],
): readonly string[] => {
  const config = REGION_CONFIGS.find((r) => r.region === region);
  if (config === undefined) {
    throw new Error(`${region}: REGION_CONFIGS に存在しないリージョン`);
  }
  if (!isNfgRegion(config)) {
    return config.preferredNfgChain as readonly string[];
  }
  return bestRawChainFor(region, chains);
};

/** send-via の候補ペア (クロス 10 + self 5)。orchestrator が override 生成式の合成に使う */
export interface SendViaPair {
  /** ペアの構成エッジ。self ペア (同一リージョン内 VPC 間) は 1 要素 */
  readonly edges: readonly string[];
  /** ペア内の NFG 端を優先度昇順で並べたもの (0〜2 要素) */
  readonly nfgEndsByPriority: readonly string[];
  /** override なしのときに選ばれる検査リージョン (静的に決まる) */
  readonly naturalPick: string;
  /**
   * フェイルオーバー時の override 値チェーン。ペアの全エッジが同一地理グループなら
   * そのグループの NFG チェーン、混合グループなら全 NFG リージョンを優先度順
   * (nfgRegionsByPriority) に並べたもの
   */
  readonly overrideChain: readonly string[];
  /**
   * true の場合、naturalPick が avoid に含まれるかどうかに関わらず override を
   * 常に生成する (NFG なしリージョンの自己ペアが対象。baseline が常設する
   * self-pair override を、orchestrator のポリシー書き換え時に失わないため)
   */
  readonly alwaysOverride: boolean;
}

/**
 * send-via single-hop の候補は「ペアの両端リージョンのみ」。
 * 自然選択: NFG 端あり -> 優先度上位の端 / NFG 端なし -> グローバル優先 #1。
 */
export const sendViaPairs = (): readonly SendViaPair[] => {
  const regions = REGION_CONFIGS.map((r) => r.region);
  const nfgOrder = nfgRegionsByPriority().map((r) => r.region);
  const globalTop = nfgOrder[0];
  const chains = rawNfgChains();
  const groupChainByRegion = Object.fromEntries(
    regions.map((region) => [region, groupChainOf(region, chains)]),
  );
  const isNfgRegionByName = (region: string): boolean =>
    REGION_CONFIGS.some((r) => r.region === region && isNfgRegion(r));
  const pairOf = (edges: readonly string[]): SendViaPair => {
    const nfgEnds = nfgOrder.filter((n) => edges.includes(n));
    const naturalPick = nfgEnds.length > 0 ? nfgEnds[0] : globalTop;
    const groupChains = edges.map((e) => groupChainByRegion[e]);
    const sameGroup = groupChains.every(
      (c) => JSON.stringify(c) === JSON.stringify(groupChains[0]),
    );
    // 同一グループ → そのグループの NFG チェーン
    // 混合グループ → ペアの NFG 端を先頭に、残りの NFG を優先度順で追加
    // (ペア端を優先することで、健全な端があればそちらで検査される)
    const overrideChain = sameGroup
      ? groupChains[0]
      : [...nfgEnds, ...nfgOrder.filter((n) => !nfgEnds.includes(n))];
    const alwaysOverride =
      edges.length === 1 && !isNfgRegionByName(edges[0]);
    return {
      edges,
      nfgEndsByPriority: nfgEnds,
      naturalPick,
      overrideChain,
      alwaysOverride,
    };
  };
  const crossPairs = regions.flatMap((a, i) =>
    regions.slice(i + 1).map((b) => pairOf([a, b])),
  );
  const selfPairs = regions.map((r) => pairOf([r]));
  return [...crossPairs, ...selfPairs];
};

/**
 * エッジごとの優先 NFG チェーンのマップ。NFG ありリージョンは [自身, ...同じ地理グループの
 * 残り NFG リージョン]、NFG なしリージョンは自身の preferredNfgChain そのもの。
 * baseline ポリシーの send-to override と、フェイルオーバーの send-to 生成
 * (チェーンを先頭から健全性判定) の両方がこのマップを使う。
 * 平常時の probe が自リージョンの NFG を通ることを保証する (帰属の機能要件)。
 */
export const preferredNfgByEdge = (): Record<string, readonly string[]> => {
  const chains = rawNfgChains();
  return Object.fromEntries(
    REGION_CONFIGS.map((r) => {
      if (isNfgRegion(r)) {
        const groupChain = bestRawChainFor(r.region, chains);
        return [
          r.region,
          [r.region, ...groupChain.filter((x) => x !== r.region)],
        ];
      }
      if (r.preferredNfgChain === undefined) {
        throw new Error(
          `${r.region}: NFG なしリージョンは preferredNfgChain の指定が必須`,
        );
      }
      return [r.region, r.preferredNfgChain];
    }),
  );
};
