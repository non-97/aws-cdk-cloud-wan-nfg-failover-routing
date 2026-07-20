"""
ヘルスチェック Lambda (唯一の Lambda)。

HealthCheck VPC の特定 AZ サブネットに固定配置され、Cloud WAN 経由
(send-to / NFG -> NAT -> internet) で複数の外部エンドポイントへ TCP 接続を試みる。
同 AZ pinning により、このトラフィックは自 AZ の NF / NAT を通る想定
(デプロイ後に FLOW ログで実測検証する)。

疎通判定は TCP 接続の確立可否で行う (HTTP ステータスには依存しない)。

疎通先は tier (段階) 構成で、tier 1 から順に試す。tier 内は並列に probe し、
1 つでも接続が確立すれば healthy として打ち切る。前の tier が全滅したときだけ
次の tier へ進む。tier 1 は AWS 管理のエンドポイント、tier 2 はサードパーティの
公開 DNS (最後の砦) で、平常時にサードパーティへ接続しないための順序である。

tier のエントリは 2 種類ある。
- {"host": ..., "port": ...}: そのままの宛先
- {"nsOfZone": ..., "port": ...}: ゾーンの NS レコードを実行のたびに問い合わせ、
  返ってきた権威ネームサーバー全台を宛先に展開する (サーバー名も IP も設定に固定しない)。
  Python 標準ライブラリの名前解決は「ホスト名 -> IP」だけで、NS などレコード種別を
  指定した問い合わせはできない。このため NS 問い合わせの送信と応答の読み取りを
  本ファイル内で行う (_query_ns)。問い合わせに失敗したときはエントリを「失敗 1 件」
  として結果に記録して先へ進み、残りの宛先が判定を担う。すべて失敗した場合のみ
  unhealthy になる (unhealthy 側に倒れる = fail-close と同じ方向で安全)

各エンドポイントには複数回 (既定 3 回 / 0.3 秒間隔) 試行し、1 回でも成功すれば ok とする
(瞬断の誤検知を吸収)。

判定: いずれかの tier で 1 つでも接続成功なら healthy。全 tier の全エンドポイントが
      (全試行) 失敗したときのみ unhealthy (宛先側障害による誤検知を防ぐ)。

応答はメトリクスフィルターが解釈する (healthy / region / azLetter / tiersProbed はトップレベルに置く)。

Lambda の異常終了 (実行時例外 / 関数タイムアウト / 設定ミスの raise) はすべて
Step Functions 側で「その AZ は unhealthy」に倒される (fail-close 方向)。
設定ミスの raise は誤検知の防止ではなく、CloudWatch Logs / FunctionError で
原因を可視化するためのもの。
"""
import json
import os
import socket
import struct
import time
from concurrent.futures import ThreadPoolExecutor

# [[{"host"|"nsOfZone": ..., "port": ...}, ...], ...] の tier 順の配列 (config.ts の probeEndpointTiers)
TIERS = json.loads(os.environ.get("PROBE_ENDPOINT_TIERS", "[]"))
# フォールバック既定値は config.ts の FAILOVER と揃える (5 秒だと最悪ケースが
# Lambda timeout 25 秒を大きく超え、環境変数欠落時に関数タイムアウト = AZ 障害誤判定になる)
TIMEOUT = float(os.environ.get("PROBE_TIMEOUT_SECONDS", "3"))
ATTEMPTS = int(os.environ.get("PROBE_ATTEMPTS", "3"))
INTERVAL = float(os.environ.get("PROBE_INTERVAL_SECONDS", "0.3"))
AZ_LETTER = os.environ.get("AZ_LETTER", "unknown")
REGION = os.environ.get("AWS_REGION", "unknown")

# NS 問い合わせの送信先。VPC 内のリソースはリンクローカルアドレス 169.254.169.253 で
# Route 53 Resolver (AmazonProvidedDNS) に到達できる (VPC ユーザーガイドに明記)。
# 自前でクエリパケットを送るため、OS の自動選択に頼らず送信先を明示する必要がある
RESOLVER = "169.254.169.253"


def _encode_qname(name):
    """問い合わせるドメイン名を DNS のワイヤ形式 (長さ付きラベルの列 + 終端 0) へ変換する。
    クエリパケットの組み立てに必要 (_query_ns の部品)。"""
    parts = name.rstrip(".").split(".")
    return b"".join(bytes([len(p)]) + p.encode("ascii") for p in parts) + b"\x00"


def _decode_name(msg, offset):
    """DNS 応答内の名前を文字列へ復元する (_query_ns の部品)。

    必要性: DNS の応答はバイナリで、応答内のドメイン名は RFC 1035 の名前圧縮
    (既出の名前をオフセットで指すポインタに置き換える形式) でほぼ必ず返ってくる。
    ポインタを辿って復元しないと、応答から権威ネームサーバー名の文字列
    (実行時に返ってきた値。コードには固定しない) を取り出せない。
    (名前, 次フィールドのオフセット) を返す。"""
    labels = []
    next_offset = None
    for _ in range(128):  # 参照ループ防止の上限
        length = msg[offset]
        if length & 0xC0 == 0xC0:  # 圧縮ポインタ (上位 2 ビットが 11)
            if next_offset is None:
                next_offset = offset + 2
            offset = ((length & 0x3F) << 8) | msg[offset + 1]
        elif length == 0:
            if next_offset is None:
                next_offset = offset + 1
            return ".".join(labels), next_offset
        else:
            labels.append(msg[offset + 1 : offset + 1 + length].decode("ascii"))
            offset += 1 + length
    raise ValueError("DNS name decompression loop")


def _recv_exact(sock, size):
    """TCP から size バイトを読み切る (_query_ns の部品)。

    必要性: DNS over TCP は「2 バイトの長さ + 本体」という長さ前置き形式のため、
    応答をサイズどおり確実に読み切る必要がある。使われるのは UDP 応答が
    切り詰められた (TC ビット) ときの TCP 再試行だけで、amazonaws.com の
    NS 応答は UDP に収まるため通常は呼ばれない (堅牢性のための保険)。"""
    buf = b""
    while len(buf) < size:
        chunk = sock.recv(size - len(buf))
        if not chunk:
            raise ValueError("DNS TCP response truncated")
        buf += chunk
    return buf


def _query_ns(zone, timeout):
    """zone の NS レコードを Route 53 Resolver へ問い合わせ、権威ネームサーバー名の
    リストを返す (NS 実行時解決の本体)。

    必要性: Python 標準ライブラリの名前解決は「ホスト名 -> IP」(A/AAAA 相当) だけで、
    NS などレコード種別を指定した問い合わせの手段が無い (dig / dnspython 相当が無い)。
    これが無いと nsOfZone エントリ (サーバー名も IP も焼き込まない実行時解決) を
    実現できないため、NS クエリ 1 種に限定して自前実装している。
    UDP で問い合わせ、応答が切り詰められた (TC) ときのみ TCP で再試行する。
    失敗は例外を投げ、呼び出し側 (_expand_tier) が失敗レコードへ変換する。"""
    header = struct.pack(
        ">HHHHHH", int.from_bytes(os.urandom(2), "big"), 0x0100, 1, 0, 0, 0
    )
    question = _encode_qname(zone) + struct.pack(">HH", 2, 1)  # QTYPE=NS / QCLASS=IN
    query = header + question
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        s.sendto(query, (RESOLVER, 53))
        msg = s.recv(4096)
    if msg[2] & 0x02:  # TC ビット -> TCP で再試行
        with socket.create_connection((RESOLVER, 53), timeout=timeout) as s:
            s.sendall(struct.pack(">H", len(query)) + query)
            size = struct.unpack(">H", _recv_exact(s, 2))[0]
            msg = _recv_exact(s, size)
    if msg[:2] != query[:2]:  # 応答 ID の照合 (別クエリの応答の取り違え防止)
        raise ValueError("DNS response id mismatch")
    qdcount, ancount = struct.unpack(">HH", msg[4:8])
    offset = 12
    for _ in range(qdcount):
        _, offset = _decode_name(msg, offset)
        offset += 4  # QTYPE + QCLASS
    names = []
    for _ in range(ancount):
        _, offset = _decode_name(msg, offset)
        rtype, _, _, rdlen = struct.unpack(">HHIH", msg[offset : offset + 10])
        offset += 10
        if rtype == 2:  # NS
            name, _ = _decode_name(msg, offset)
            names.append(name)
        offset += rdlen
    if not names:
        raise ValueError(f"no NS records for {zone}")
    return sorted(names)


def _expand_tier(tier):
    """tier のエントリを実際の probe 対象 (host / port) のリストへ展開する。
    host 直指定はそのまま、nsOfZone はゾーンの NS レコードを実行時に引いて
    権威ネームサーバー全台へ展開する (サーバー名も IP も設定に焼き込まないため)。
    NS の問い合わせに失敗したときは、エラー終了ではなく失敗レコード 1 件として
    返して先へ進む。残りの宛先が判定を担い、全滅した場合のみ unhealthy になる。"""
    endpoints = []
    failures = []
    for entry in tier:
        if "nsOfZone" in entry:
            zone = entry["nsOfZone"]
            try:
                for name in _query_ns(zone, TIMEOUT):
                    endpoints.append({"host": name, "port": entry["port"]})
            except Exception as exc:  # noqa: BLE001 lookup 失敗は unhealthy 候補として記録
                failures.append(
                    {
                        "host": f"NS?{zone}",
                        "port": entry["port"],
                        "ok": False,
                        "error": f"NS lookup failed: {exc}",
                        "latencyMs": 0,
                    }
                )
        else:
            endpoints.append(dict(entry))
    return endpoints, failures


def _probe(endpoint):
    """1 エンドポイントへ最大 ATTEMPTS 回 TCP 接続を試み、1 回でも成功すれば ok とする。"""
    host = endpoint["host"]
    port = int(endpoint["port"])
    start = time.monotonic()
    last_error = None
    for attempt in range(ATTEMPTS):
        try:
            with socket.create_connection((host, port), timeout=TIMEOUT):
                return {
                    "host": host,
                    "port": port,
                    "ok": True,
                    "attempt": attempt + 1,
                    "latencyMs": int((time.monotonic() - start) * 1000),
                }
        except Exception as exc:  # noqa: BLE001 接続失敗 (名前解決失敗を含む) は全て unhealthy 候補
            last_error = str(exc)
            if attempt < ATTEMPTS - 1:
                time.sleep(INTERVAL)
    return {
        "host": host,
        "port": port,
        "ok": False,
        "attempts": ATTEMPTS,
        "error": last_error,
        "latencyMs": int((time.monotonic() - start) * 1000),
    }


def handler(event, context):
    # 設定ミス (環境変数欠落 / 空 tier) は明示的に失敗させ、FunctionError として可視化する
    # (Step Functions 側では unhealthy 扱いになる。fail-close 方向なので安全側)
    if not TIERS or not all(isinstance(tier, list) and tier for tier in TIERS):
        raise RuntimeError("PROBE_ENDPOINT_TIERS is not set or has an empty tier")
    start = time.monotonic()
    results = []
    healthy = False
    tiers_probed = 0
    for tier_index, tier in enumerate(TIERS):
        tiers_probed = tier_index + 1
        endpoints, tier_results = _expand_tier(tier)
        if endpoints:
            with ThreadPoolExecutor(max_workers=len(endpoints)) as executor:
                tier_results.extend(executor.map(_probe, endpoints))
        for r in tier_results:
            r["tier"] = tier_index + 1
        results.extend(tier_results)
        if any(r["ok"] for r in tier_results):
            healthy = True
            break
    response = {
        "healthy": healthy,
        "azLetter": AZ_LETTER,
        "region": REGION,
        # 実際に試行した tier 数。2 以上 = tier 1 が全滅しサードパーティ (最後の砦) に
        # 接触した。メトリクスフィルターが ProbeTier2Contact として発行する
        "tiersProbed": tiers_probed,
        # 判定確定までの所要時間 (疎通レイテンシ)。メトリクスフィルターが
        # ProbeLatencyMs として発行し、劣化の先行指標に使う
        "latencyMs": int((time.monotonic() - start) * 1000),
        "results": results,
    }
    print(json.dumps(response))
    return response
