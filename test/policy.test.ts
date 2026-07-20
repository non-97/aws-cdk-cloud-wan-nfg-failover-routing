import { buildBaselineCoreNetworkPolicy } from "../lib/core-network-policy";

describe("baseline Core Network Policy", () => {
  // eslint 不要。生成結果を型なしで検証する
  const policy = buildBaselineCoreNetworkPolicy() as Record<string, any>;

  test("edge-locations は 5 リージョン", () => {
    const edges = policy["core-network-configuration"]["edge-locations"];
    expect(edges).toHaveLength(5);
  });

  test("直接 PutCoreNetworkPolicy で必須の 2 キーを明示している", () => {
    // 省略するとフェイルオーバー実行時に初めて検証エラーになる (実機確認済みの罠)
    const config = policy["core-network-configuration"];
    expect(config["dns-support"]).toBe(true);
    expect(config["security-group-referencing-support"]).toBe(true);
  });

  test("workload セグメントが存在し isolate-attachments は false", () => {
    const segment = policy.segments[0];
    expect(segment.name).toBe("workload");
    expect(segment["isolate-attachments"]).toBe(false);
  });

  test("inspection NFG が存在", () => {
    expect(policy["network-function-groups"][0].name).toBe("inspection");
  });

  test("RFC1918 全帯の blackhole 静的ルートを常設する", () => {
    const actions = policy["segment-actions"];
    const blackhole = actions.find((a: any) => a.action === "create-route");
    expect(blackhole.segment).toBe("workload");
    expect(blackhole["destination-cidr-blocks"]).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
    expect(blackhole.destinations).toEqual(["blackhole"]);
  });

  test("send-to / send-via が inspection NFG 経由", () => {
    const actions = policy["segment-actions"];
    const sendTo = actions.find((a: any) => a.action === "send-to");
    const sendVia = actions.find((a: any) => a.action === "send-via");
    expect(sendTo.via["network-function-groups"]).toEqual(["inspection"]);
    expect(sendVia.via["network-function-groups"]).toEqual(["inspection"]);
    expect(sendVia.mode).toBe("single-hop");
  });

  test("baseline の send-to は preferredNfg への per-edge override を常設する", () => {
    const actions = policy["segment-actions"];
    const sendTo = actions.find((a: any) => a.action === "send-to");
    expect(sendTo.via["with-edge-overrides"]).toEqual([
      { "edge-sets": [["us-east-1"]], "use-edge-location": "us-east-1" },
      { "edge-sets": [["us-west-2"]], "use-edge-location": "us-east-1" },
      { "edge-sets": [["ap-northeast-1"]], "use-edge-location": "ap-northeast-1" },
      { "edge-sets": [["ap-northeast-3"]], "use-edge-location": "ap-northeast-3" },
      { "edge-sets": [["ap-southeast-1"]], "use-edge-location": "ap-northeast-1" },
    ]);
  });

  test("baseline の send-via は with-edge-overrides を含まない (override はランタイム生成)", () => {
    const actions = policy["segment-actions"];
    const sendVia = actions.find((a: any) => a.action === "send-via");
    expect(sendVia.via["with-edge-overrides"]).toBeUndefined();
  });
});
