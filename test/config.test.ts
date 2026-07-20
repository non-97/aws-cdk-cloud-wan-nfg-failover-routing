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

describe("preferredNfgByEdge (baseline / failover 共有の優先 NFG マップ)", () => {
  test("NFG ありは自身、なしは最近傍の NFG", () => {
    expect(preferredNfgByEdge()).toEqual({
      "us-east-1": "us-east-1",
      "us-west-2": "us-east-1",
      "ap-northeast-1": "ap-northeast-1",
      "ap-northeast-3": "ap-northeast-3",
      "ap-southeast-1": "ap-northeast-1",
    });
  });
});
