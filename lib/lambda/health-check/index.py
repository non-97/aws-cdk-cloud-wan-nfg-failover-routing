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

応答は EMF (Embedded Metric Format) で CloudWatch がメトリクスを直接抽出する
(healthy / region / azId / tiersProbed はメトリクスではない診断情報としてトップレベルに置く)。

残り実行時間が尽きる手前 (DEADLINE_RESERVE_MS) で probe を打ち切り、必ず EMF を
出力してから戻る。関数がタイムアウトすると EMF に到達せず ProbeUnhealthy が 1 件も
発行されず、検査経路の障害を検知するはずのアラームとダッシュボードが沈黙するため。
打ち切った場合は診断情報の truncated を true にする。
進捗は tier ごと / エンドポイントごとに logging で出力するので、万一タイムアウトしても
どこまで進んだかを追える (_log)。

Lambda の異常終了 (実行時例外 / 関数タイムアウト / 設定ミスの raise) はすべて
Step Functions 側で「その AZ は unhealthy」に倒される (fail-close 方向)。
設定ミスの raise は誤検知の防止ではなく、CloudWatch Logs / FunctionError で
原因を可視化するためのもの。
"""
import json
import logging
import os
import socket
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as futures_wait

# 進捗ログ。Lambda のログフォーマットを JSON にしているため、logging 経由の出力は
# timestamp / level / message / logger / requestId を持つ JSON レコードになる。
# 一方 print() の出力は素通しされる (公式ドキュメントに明記) ため、EMF は print() のまま
# 出力する。logging に載せると _aws がネストして CloudWatch が抽出できなくなる。
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _log(event, _level=logging.INFO, **fields):
    """進捗を 1 レコードの JSON として出力する。

    extra に渡した辞書のキーはログレコードのトップレベルに展開される
    (公式ドキュメントに記載)。json.dumps した文字列を message に入れると
    エスケープされた JSON が入れ子になり、Logs Insights からフィールドとして
    扱えなくなるため extra を使う。
    message の中に構造を持たせることはできない。Lambda ランタイムの JsonFormatter は
    message を record.getMessage() の戻り値で組み立てており、辞書を渡しても型判定を
    しないため Python の repr 文字列になる (awslambdaric の実装で確認)。
    キー名は logging.LogRecord の属性 (message / module / args / name など) と
    衝突させないこと。衝突すると KeyError になる。
    """
    logger.log(_level, event, extra=fields)

# [[{"host"|"nsOfZone": ..., "port": ...}, ...], ...] の tier 順の配列 (config.ts の probeEndpointTiers)
TIERS = json.loads(os.environ.get("PROBE_ENDPOINT_TIERS", "[]"))
# フォールバック既定値は config.ts の FAILOVER と揃える (大きすぎる値だと probe が
# 期限切れで打ち切られ、経路が健全でも unhealthy と報告してしまう)
TIMEOUT = float(os.environ.get("PROBE_TIMEOUT_SECONDS", "3"))
ATTEMPTS = int(os.environ.get("PROBE_ATTEMPTS", "3"))
INTERVAL = float(os.environ.get("PROBE_INTERVAL_SECONDS", "0.3"))
REGION = os.environ.get("AWS_REGION", "unknown")
# EMF のディメンション値 (ログイベントのフィールドとして発行するため環境変数で受け取る)
CORE_NETWORK_ID = os.environ.get("CORE_NETWORK_ID", "unknown")
# EMF の Namespace。config.ts の MONITORING.namespace と一致させる必要があるため
# Lambda 側では固定値を持たず環境変数で渡す
METRIC_NAMESPACE = os.environ.get("METRIC_NAMESPACE", "NfgFailover")
# EMF の出力に必ず到達するための予約時間 (ミリ秒)。関数タイムアウトのこの手前で probe を
# 打ち切る。関数がタイムアウトすると EMF が出力されず ProbeUnhealthy が 1 件も発行されない
# ため、検査経路の障害を検知するはずのアラームとダッシュボードが沈黙してしまう
DEADLINE_RESERVE_MS = 2000
# 1 つの tier に費やす時間の上限 (秒)。1 エンドポイントの最悪ケース
# (試行回数 x 接続タイムアウト + 試行間隔の合計) に、名前解決とスレッド起動の余裕を足す。
# これがないと 1 つの tier が持ち時間を使い切り、次の tier を試せなくなる
TIER_MAX_SECONDS = ATTEMPTS * TIMEOUT + (ATTEMPTS - 1) * INTERVAL + 2


def _get_az_id():
    """Lambda メタデータエンドポイントから AZ ID を取得する。

    取得に失敗した場合は環境変数 AZ (実 AZ 名) にフォールバックする。
    フォールバック値は AZ ID と形式が異なるため、CloudWatch のディメンション値が
    分裂してアラームの継続判定が働かなくなる。原因を追えるようログに残す。
    """
    api = os.environ.get("AWS_LAMBDA_METADATA_API")
    token = os.environ.get("AWS_LAMBDA_METADATA_TOKEN")
    fallback = os.environ.get("AZ", "unknown")
    if not api or not token:
        _log("azIdFallback", _level=logging.WARNING, reason="metadata endpoint env vars not set", value=fallback)
        return fallback
    req = urllib.request.Request(
        f"http://{api}/2026-01-15/metadata/execution-environment",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return json.loads(resp.read())["AvailabilityZoneID"]
    except Exception as e:  # noqa: BLE001 メタデータ取得失敗時は環境変数 AZ にフォールバック
        _log("azIdFallback", _level=logging.WARNING, reason=f"{type(e).__name__}: {e}", value=fallback)
        return fallback


# メタデータエンドポイントが使えない場合 (ローカルテスト等) は環境変数 AZ にフォールバック
AZ_ID = _get_az_id()

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


def _budget_seconds(context):
    """EMF を出力するための予約時間を差し引いた、probe に使える残り秒数。

    ローカルテストなど context が無い場合は上限なしとして扱う。"""
    if context is None or not hasattr(context, "get_remaining_time_in_millis"):
        return float("inf")
    return (context.get_remaining_time_in_millis() - DEADLINE_RESERVE_MS) / 1000.0


def _expand_tier(tier, ns_timeout):
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
                # 残り時間が少ないときは NS 解決の待ちも短縮する (打ち切りより結果の出力を優先)
                for name in _query_ns(zone, max(min(TIMEOUT, ns_timeout), 0.1)):
                    endpoints.append({"host": name, "port": entry["port"]})
            except Exception as exc:  # noqa: BLE001 lookup 失敗は unhealthy 候補として記録
                failures.append(
                    {
                        "host": f"NS?{zone}",
                        "port": entry["port"],
                        "connected": False,
                        "error": f"NS lookup failed: {exc}",
                        "latencyMs": 0,
                    }
                )
        else:
            endpoints.append(dict(entry))
    return endpoints, failures


def _probe(endpoint, deadline):
    """1 エンドポイントへ最大 ATTEMPTS 回 TCP 接続を試み、1 回でも成功すれば connected とする。

    socket.create_connection は使わない。あれは getaddrinfo が返した**アドレスごとに**
    timeout を適用するため、1 回の呼び出しの上限が「解決したアドレス数 x timeout」に
    膨らむ。checkip.amazonaws.com は 8 アドレスに解決されるので 1 試行で最大 24 秒かかり、
    関数の持ち時間を使い切って次の tier を試せなくなる (2026-07-28 実機で確認)。
    ここでは自分で解決し、1 試行につき 1 アドレスへ接続することで上限を TIMEOUT に固定する。

    deadline は打ち切りの time.monotonic() 基準時刻。試行の合間に超過を確認して抜ける。
    getaddrinfo 自体には上限を設けられないため、呼び出し側でも待ちを打ち切る。"""
    host = endpoint["host"]
    port = int(endpoint["port"])
    start = time.monotonic()

    def _finish(**extra):
        result = {
            "host": host,
            "port": port,
            "latencyMs": int((time.monotonic() - start) * 1000),
            **extra,
        }
        _log("probeEndpoint", **result)
        return result

    try:
        # 第 3 引数の AF_INET は IPv4 のアドレスだけを返させる指定 (省略すると IPv6 も返る)。
        # この VPC は IPv4 で構成しており Lambda の ENI に IPv6 アドレスが付かないため、
        # IPv6 のアドレスは送信元アドレスを用意できず Errno 99
        # (Cannot assign requested address) で即失敗する。create_connection が最後の
        # 例外を返す仕様と相まって、本来の失敗理由である IPv4 の接続タイムアウトを
        # 覆い隠してしまうため、候補の段階で除外する
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    except Exception as exc:  # noqa: BLE001 名前解決の失敗も unhealthy 候補
        return _finish(
            connected=False,
            attempts=0,
            error=f"getaddrinfo failed: {type(exc).__name__}: {exc}",
        )

    last_error = None
    last_address = None
    attempts_made = 0
    for attempt in range(ATTEMPTS):
        if time.monotonic() >= deadline:
            last_error = (
                f"deadline reached after {attempts_made} attempt(s): {last_error}"
            )
            break
        attempts_made = attempt + 1
        # 試行ごとに別のアドレスを使う (特定の 1 台だけが落ちている場合の誤判定を避ける)
        family, socktype, proto, _, sockaddr = infos[attempt % len(infos)]
        last_address = sockaddr[0]
        try:
            with socket.socket(family, socktype, proto) as sock:
                sock.settimeout(TIMEOUT)
                sock.connect(sockaddr)
            return _finish(
                connected=True, attempt=attempts_made, address=last_address
            )
        except Exception as exc:  # noqa: BLE001 接続失敗は全て unhealthy 候補
            last_error = f"{type(exc).__name__}: {exc}"
            if attempt < ATTEMPTS - 1:
                time.sleep(INTERVAL)
    return _finish(
        connected=False,
        attempts=attempts_made,
        addresses=len(infos),
        address=last_address,
        error=last_error,
    )


def handler(event, context):
    # 設定ミス (環境変数欠落 / 空 tier) は明示的に失敗させ、FunctionError として可視化する
    # (Step Functions 側では unhealthy 扱いになる。fail-close 方向なので安全側)
    if not TIERS or not all(isinstance(tier, list) and tier for tier in TIERS):
        raise RuntimeError("PROBE_ENDPOINT_TIERS is not set or has an empty tier")
    results = []
    healthy = False
    tiers_probed = 0
    ns_lookup_ms = 0
    truncated = False
    _log("probeStart", region=REGION, azId=AZ_ID, tiers=len(TIERS),
         budgetSeconds=round(_budget_seconds(context), 2))
    for tier_index, tier in enumerate(TIERS):
        budget = _budget_seconds(context)
        if budget <= 0:
            # 残り時間が尽きた。ここで抜けて EMF を出力する (関数タイムアウトで
            # 何も出力されないより、未確定分を unhealthy 側に倒して報告する方が安全)
            truncated = True
            _log("probeTruncated", tier=tier_index + 1, reason="no budget left")
            break
        tiers_probed = tier_index + 1
        _log("tierStart", tier=tiers_probed, budgetSeconds=round(budget, 2))
        ns_start = time.monotonic()
        endpoints, tier_results = _expand_tier(tier, budget)
        ns_lookup_ms += int((time.monotonic() - ns_start) * 1000)
        _log("tierExpanded", tier=tiers_probed,
             endpoints=[f"{e['host']}:{e['port']}" for e in endpoints],
             nsFailures=len(tier_results),
             elapsedMs=int((time.monotonic() - ns_start) * 1000))
        if endpoints:
            # 1 つの tier が持ち時間を使い切って次の tier を試せなくなるのを防ぐため、
            # 残り予算とは別に tier あたりの上限を設ける
            tier_budget = min(_budget_seconds(context), TIER_MAX_SECONDS)
            deadline = time.monotonic() + tier_budget
            # map ではなく submit + wait を使う。map は全ワーカーの完了を待つため、
            # getaddrinfo でブロックしたワーカーが 1 つでもあると全体が止まり、
            # 関数タイムアウトで EMF が出力されなくなる
            executor = ThreadPoolExecutor(max_workers=len(endpoints))
            try:
                futures = {
                    executor.submit(_probe, ep, deadline): ep for ep in endpoints
                }
                _, pending = futures_wait(
                    set(futures), timeout=max(tier_budget, 0.0)
                )
                for future in futures:
                    if future in pending:
                        ep = futures[future]
                        truncated = True
                        tier_results.append({
                            "host": ep["host"],
                            "port": ep["port"],
                            "connected": False,
                            "error": "deadline exceeded (probe did not return)",
                            "latencyMs": int(tier_budget * 1000),
                        })
                    else:
                        tier_results.append(future.result())
            finally:
                # 打ち切った probe の完了は待たない。走行中のスレッドは
                # getaddrinfo / connect 自身のタイムアウトで自然に終了する
                executor.shutdown(wait=False, cancel_futures=True)
        for r in tier_results:
            r["tier"] = tier_index + 1
        results.extend(tier_results)
        connected = sum(1 for r in tier_results if r["connected"])
        _log("tierDone", tier=tiers_probed, connected=connected,
             total=len(tier_results))
        if connected:
            healthy = True
            break

    # 検査経路のレイテンシ = 成功した接続の最小値 (経路の実力値)。DNS 解決
    # (VPC リゾルバー宛。検査経路を通らない) の時間はノイズになるため含めない
    connected_results = [r for r in results if r.get("connected")]
    inspection_latency_ms = min(
        (r["latencyMs"] for r in connected_results), default=-1
    )

    metrics = [
        {"Name": "ProbeHealthy", "Unit": "Count"},
        {"Name": "ProbeUnhealthy", "Unit": "Count"},
        {"Name": "ProbeTier2Contact", "Unit": "Count"},
    ]
    if inspection_latency_ms >= 0:
        metrics.append({"Name": "ProbeLatencyMs", "Unit": "Milliseconds"})

    response = {
        # CloudWatch が自動でメトリクスを抽出する EMF のメタデータ。
        # メトリクスフィルターを使わず Lambda から直接発行することで、
        # ディメンション値をすべてログフィールド由来にできる
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": METRIC_NAMESPACE,
                    "Dimensions": [
                        ["EdgeLocation", "AvailabilityZone", "CoreNetwork"]
                    ],
                    "Metrics": metrics,
                }
            ],
        },
        # ディメンション
        "EdgeLocation": REGION,
        "AvailabilityZone": AZ_ID,
        "CoreNetwork": CORE_NETWORK_ID,
        # メトリクス値
        "ProbeHealthy": 1 if healthy else 0,
        "ProbeUnhealthy": 0 if healthy else 1,
        "ProbeTier2Contact": 1 if tiers_probed >= 2 else 0,
        # 診断情報 (メトリクスではない)。healthy は Step Functions が判定に使う
        "healthy": healthy,
        "tiersProbed": tiers_probed,
        # NS 解決 (VPC リゾルバー宛) の所要時間。検査経路を通らないため
        # ProbeLatencyMs とは分けて記録する
        "nsLookupMs": ns_lookup_ms,
        # 残り時間が尽きて probe を打ち切ったかどうか。true が続く場合は関数タイムアウトの
        # 設定か tier 構成を見直す (この場合の unhealthy は経路障害と断定できない)
        "truncated": truncated,
        "results": results,
    }
    if inspection_latency_ms >= 0:
        # 検査経路のレイテンシ = 成功した接続の最小値 (経路の実力値)。
        # 全滅時はメトリクスを発行しない (欠損として扱う)
        response["ProbeLatencyMs"] = inspection_latency_ms
    print(json.dumps(response))
    return response
