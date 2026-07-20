import {
  FAILOVER,
  REGION_CONFIGS,
  failoverTargetRegion,
  nfgPriorityMap,
  nfgRegionsByPriority,
  preferredNfgByEdge,
  sendViaPairs,
} from "../lib/config";

describe("config の整合性", () => {
  test("workload CIDR は全リージョン x 2 本で一意", () => {
    const cidrs = REGION_CONFIGS.flatMap((r) => r.workloadCidrs);
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });

  test("全 VPC CIDR (workload x2 / inspection / healthcheck) は一意", () => {
    const cidrs = REGION_CONFIGS.flatMap((r) =>
      [...r.workloadCidrs, r.inspectionCidr, r.healthCheckCidr].filter(
        (c): c is string => c !== undefined,
      ),
    );
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });

  test("全 VPC CIDR は範囲としても重複しない (包含関係も検出)", () => {
    const cidrToRange = (cidr: string): readonly [number, number] => {
      const [ip, prefixStr] = cidr.split("/");
      const base = ip
        .split(".")
        .reduce((acc, oct) => acc * 256 + Number(oct), 0);
      const size = 2 ** (32 - Number(prefixStr));
      return [base, base + size - 1];
    };
    const cidrs = REGION_CONFIGS.flatMap((r) =>
      [...r.workloadCidrs, r.inspectionCidr, r.healthCheckCidr].filter(
        (c): c is string => c !== undefined,
      ),
    );
    const overlaps = cidrs.flatMap((a, i) =>
      cidrs
        .slice(i + 1)
        .filter((b) => {
          const [aStart, aEnd] = cidrToRange(a);
          const [bStart, bEnd] = cidrToRange(b);
          return aStart <= bEnd && bStart <= aEnd;
        })
        .map((b) => `${a} <-> ${b}`),
    );
    expect(overlaps).toEqual([]);
  });

  test("ASN は一意", () => {
    const asns = REGION_CONFIGS.map((r) => r.asn);
    expect(new Set(asns).size).toBe(asns.length);
  });

  test("優先度は一意", () => {
    const ps = REGION_CONFIGS.map((r) => r.defaultPriority);
    expect(new Set(ps).size).toBe(ps.length);
  });
});

describe("probeEndpointTiers (AWS 管理優先の tier 構成)", () => {
  test("tier 1 は AWS 管理 (NS 実行時解決 + checkip)、tier 2 はサードパーティの最後の砦", () => {
    expect(FAILOVER.probeEndpointTiers).toHaveLength(2);
    expect(FAILOVER.probeEndpointTiers[0]).toEqual([
      { nsOfZone: "amazonaws.com", port: 53 },
      { host: "checkip.amazonaws.com", port: 443 },
    ]);
    expect(FAILOVER.probeEndpointTiers[1]).toEqual([
      { host: "1.1.1.1", port: 53 },
      { host: "8.8.8.8", port: 53 },
    ]);
  });
});

describe("優先度に基づく次点リージョン計算", () => {
  test("nfgPriorityMap は NFG ありリージョンのみ", () => {
    expect(nfgPriorityMap()).toEqual({
      "us-east-1": 1,
      "ap-northeast-1": 7,
      "ap-northeast-3": 9,
    });
  });

  test("nfgRegionsByPriority は優先度昇順", () => {
    expect(nfgRegionsByPriority().map((r) => r.region)).toEqual([
      "us-east-1",
      "ap-northeast-1",
      "ap-northeast-3",
    ]);
  });

  test("多段フェイルオーバー: avoidRegions を除外した最優先を返す", () => {
    expect(failoverTargetRegion([])).toBe("us-east-1");
    expect(failoverTargetRegion(["us-east-1"])).toBe("ap-northeast-1");
    expect(failoverTargetRegion(["us-east-1", "ap-northeast-1"])).toBe(
      "ap-northeast-3",
    );
  });

  test("全 NFG リージョンを avoid すると undefined (fail-close)", () => {
    expect(
      failoverTargetRegion(["us-east-1", "ap-northeast-1", "ap-northeast-3"]),
    ).toBeUndefined();
  });

  test("NFG なしリージョンを avoid しても影響しない", () => {
    expect(failoverTargetRegion(["us-west-2"])).toBe("us-east-1");
  });
});

describe("sendViaPairs (send-via per-pair override の素材)", () => {
  const pairs = sendViaPairs();
  const byEdges = (edges: string[]) =>
    pairs.find((p) => JSON.stringify(p.edges) === JSON.stringify(edges));

  test("クロス 10 + self 5 の計 15 ペア", () => {
    expect(pairs).toHaveLength(15);
    expect(pairs.filter((p) => p.edges.length === 2)).toHaveLength(10);
    expect(pairs.filter((p) => p.edges.length === 1)).toHaveLength(5);
  });

  test("naturalPick の全表 (候補はペアの両端のみ、NFG 端なしはグローバル #1)", () => {
    expect(byEdges(["us-east-1", "us-west-2"])?.naturalPick).toBe("us-east-1");
    expect(byEdges(["us-east-1", "ap-northeast-1"])?.naturalPick).toBe(
      "us-east-1",
    );
    expect(byEdges(["us-east-1", "ap-northeast-3"])?.naturalPick).toBe(
      "us-east-1",
    );
    expect(byEdges(["us-west-2", "ap-northeast-1"])?.naturalPick).toBe(
      "ap-northeast-1",
    );
    expect(byEdges(["us-west-2", "ap-northeast-3"])?.naturalPick).toBe(
      "ap-northeast-3",
    );
    expect(byEdges(["ap-northeast-1", "ap-northeast-3"])?.naturalPick).toBe(
      "ap-northeast-1",
    );
    expect(byEdges(["us-east-1"])?.naturalPick).toBe("us-east-1");
    expect(byEdges(["us-west-2"])?.naturalPick).toBe("us-east-1");
    expect(byEdges(["ap-northeast-1"])?.naturalPick).toBe("ap-northeast-1");
    expect(byEdges(["ap-northeast-3"])?.naturalPick).toBe("ap-northeast-3");
    expect(byEdges(["us-east-1", "ap-southeast-1"])?.naturalPick).toBe(
      "us-east-1",
    );
    expect(byEdges(["us-west-2", "ap-southeast-1"])?.naturalPick).toBe(
      "us-east-1",
    );
    expect(byEdges(["ap-northeast-1", "ap-southeast-1"])?.naturalPick).toBe(
      "ap-northeast-1",
    );
    expect(byEdges(["ap-northeast-3", "ap-southeast-1"])?.naturalPick).toBe(
      "ap-northeast-3",
    );
    expect(byEdges(["ap-southeast-1"])?.naturalPick).toBe("us-east-1");
  });

  test("nfgEndsByPriority は優先度昇順", () => {
    expect(
      byEdges(["ap-northeast-1", "ap-northeast-3"])?.nfgEndsByPriority,
    ).toEqual(["ap-northeast-1", "ap-northeast-3"]);
    expect(byEdges(["us-west-2"])?.nfgEndsByPriority).toEqual([]);
    expect(byEdges(["us-west-2", "ap-southeast-1"])?.nfgEndsByPriority).toEqual(
      [],
    );
  });
});

describe("preferredNfgByEdge (baseline / failover 共有の優先 NFG チェーンマップ)", () => {
  test("戻り値は Record<string, readonly string[]>。地理グループ (US/AP) 別のフォールバックチェーン", () => {
    const result: Record<string, readonly string[]> = preferredNfgByEdge();
    expect(result).toEqual({
      "us-east-1": ["us-east-1", "ap-northeast-1", "ap-northeast-3"],
      "us-west-2": ["us-east-1", "ap-northeast-1", "ap-northeast-3"],
      "ap-northeast-1": ["ap-northeast-1", "ap-northeast-3", "us-east-1"],
      "ap-northeast-3": ["ap-northeast-3", "ap-northeast-1", "us-east-1"],
      "ap-southeast-1": ["ap-northeast-1", "ap-northeast-3", "us-east-1"],
    });
  });

  // ovrToExpr (orchestrator-stack.ts) の $filter + $healthy[0] を TypeScript 側で
  // 再現し、チェーン走査の結果が地理グループ内で完結することを検証する。
  // apne1 ダウン時に apse1/apne1 が use1 (米国) ではなく apne3 (同じ AP グループ) へ
  // フォールバックすることが本タスクの目的
  const firstHealthy = (
    edge: string,
    avoid: readonly string[],
  ): string | undefined => {
    const chain = preferredNfgByEdge()[edge];
    return chain.find((r) => !avoid.includes(r));
  };

  test("チェーン走査: avoid={apne1} で apse1 は apne3 にフォールバックする (use1 を経由しない)", () => {
    expect(firstHealthy("ap-southeast-1", ["ap-northeast-1"])).toBe(
      "ap-northeast-3",
    );
    expect(firstHealthy("ap-northeast-1", ["ap-northeast-1"])).toBe(
      "ap-northeast-3",
    );
  });

  test("チェーン走査: avoid={apne3} で apne3 は apne1 にフォールバックする", () => {
    expect(firstHealthy("ap-northeast-3", ["ap-northeast-3"])).toBe(
      "ap-northeast-1",
    );
  });

  test("チェーン走査: US グループは変化なし (use1 ダウンでも apne1 が次点)", () => {
    expect(firstHealthy("us-west-2", ["us-east-1"])).toBe("ap-northeast-1");
    expect(firstHealthy("us-east-1", ["us-east-1"])).toBe("ap-northeast-1");
  });

  test("チェーン走査: AP グループ全滅時は use1 にフォールバックする", () => {
    expect(
      firstHealthy("ap-southeast-1", ["ap-northeast-1", "ap-northeast-3"]),
    ).toBe("us-east-1");
  });
});

describe("sendViaPairs の overrideChain / alwaysOverride", () => {
  const pairs = sendViaPairs();
  const byEdges = (edges: string[]) =>
    pairs.find((p) => JSON.stringify(p.edges) === JSON.stringify(edges));

  test("同一グループ (AP) のクロスペアは AP チェーンを使う", () => {
    expect(
      byEdges(["ap-northeast-1", "ap-northeast-3"])?.overrideChain,
    ).toEqual(["ap-northeast-1", "ap-northeast-3", "us-east-1"]);
  });

  test("同一グループ (US) のクロスペアは US チェーンを使う", () => {
    expect(byEdges(["us-east-1", "us-west-2"])?.overrideChain).toEqual([
      "us-east-1",
      "ap-northeast-1",
      "ap-northeast-3",
    ]);
  });

  test("混合グループのクロスペアはペアの NFG 端を先頭に、残りを優先度順で追加", () => {
    // usw2 ↔ apne1: NFG 端 = [apne1] (usw2 は NFG なし)、残り = [use1, apne3]
    expect(byEdges(["us-west-2", "ap-northeast-1"])?.overrideChain).toEqual([
      "ap-northeast-1",
      "us-east-1",
      "ap-northeast-3",
    ]);
    // use1 ↔ apne3: NFG 端 = [use1, apne3]、残り = [apne1]
    expect(byEdges(["us-east-1", "ap-northeast-3"])?.overrideChain).toEqual([
      "us-east-1",
      "ap-northeast-3",
      "ap-northeast-1",
    ]);
    // apne3 ↔ apse1: 同一 AP グループ → AP チェーン [apne1, apne3, use1]
    expect(byEdges(["ap-northeast-3", "ap-southeast-1"])?.overrideChain).toEqual([
      "ap-northeast-1",
      "ap-northeast-3",
      "us-east-1",
    ]);
  });

  test("NFG ありリージョンの自己ペア (apne1/apne3) は自身のグループチェーンを使う", () => {
    expect(byEdges(["ap-northeast-1"])?.overrideChain).toEqual([
      "ap-northeast-1",
      "ap-northeast-3",
      "us-east-1",
    ]);
    expect(byEdges(["ap-northeast-3"])?.overrideChain).toEqual([
      "ap-northeast-1",
      "ap-northeast-3",
      "us-east-1",
    ]);
  });

  test("alwaysOverride は NFG なしリージョンの自己ペアのみ true", () => {
    expect(byEdges(["us-west-2"])?.alwaysOverride).toBe(true);
    expect(byEdges(["ap-southeast-1"])?.alwaysOverride).toBe(true);
    expect(byEdges(["us-east-1"])?.alwaysOverride).toBe(false);
    expect(byEdges(["ap-northeast-1"])?.alwaysOverride).toBe(false);
    expect(byEdges(["ap-northeast-3"])?.alwaysOverride).toBe(false);
    expect(byEdges(["us-east-1", "us-west-2"])?.alwaysOverride).toBe(false);
  });
});
